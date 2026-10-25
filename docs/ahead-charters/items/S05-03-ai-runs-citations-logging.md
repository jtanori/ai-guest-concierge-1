---
id: S05-03
title: ai_runs + citations logging
sprint: S05
epic: S05 - AI core and evaluation
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S05-01]
labels: [sprint:S05, track:foundation, prio:P0]
milestone: S05 - AI core and evaluation
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/75
pickup: ready
---

# S05-03 — ai_runs + citations logging

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S05 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S05-01 |
| Pickup | `ready` |

## 1. Why / goal

Make every historical answer reconstructable from the database (D5).

## 2. Acceptance criteria (backlog AC verbatim)

> Any historical answer reconstructable from the database.

- **AC-1** For any `ai_run_id`, the exact prompt version, model id, decision, citations and cited `article_version` bodies can be reconstructed.
- **AC-2** Editing an article does not change what an old answer cited (versions are immutable, 0003).

## 3. Scope

**In:** Logging service, reconstruction query, indexes.

**Out:** Changing `ai_runs`/`citations` — both already exist in 0001 with the right columns.

## 4. Calculated changes (for the coding agent)

- `src/ai/log.ts`: `recordAiRun(client, context, {conversationId, messageId, modelId, promptVersion, output, latencyMs, usage, retrieved})` — `INSERT INTO ai_runs (...)` then one `INSERT INTO citations (...)` per citation, in the caller's transaction. Use the `UNIQUE (org_id,property_id,ai_run_id)` composite FKs already in 0001.
- `src/ai/history.ts`: `reconstructAnswer(client, context, aiRunId)` joins `ai_runs` → `citations` → `article_versions` on `(org_id, property_id, article_version_id)` and returns the exact bodies that were cited, plus `handoff_reasons` for escalations.
- Migration `0013_ai_runs_indexes.sql`: `CREATE INDEX ai_runs_property_time ON ai_runs (property_id, created_at DESC)`, `CREATE INDEX citations_run ON citations (org_id, property_id, ai_run_id)`, and a CHECK on `ai_runs.usage` being an object (`jsonb_typeof(usage)='object'`).
- Add `prompt_version` + `model_id` to the `src/ai/prompt.ts` constants so a change is a diff, not a config drift; write an `ai_run_completed` event via `src/events/taxonomy.ts::createEvent` (S10-01 instruments the writer later — keep the event call behind a small `emitEvent` stub that S10-01 fills in).

## 5. Tenancy & security

`reconstructAnswer` must take the same `TenantContext` and rely on RLS; foreign `ai_run_id` → `FactNotFound`-style not-found, never a leak.

## 6. Test plan (named cases)

- `tests/db/ai-runs.db.test.ts`: reconstruct after the article is edited (new version created) and assert the old body is returned; cross-tenant `ai_run_id` → not found; a citation to a non-retrieved version is impossible.
- `tests/audit/detail.test.ts` (exists) for safe detail.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- ``npm test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — schema and modules exist. Depends only on S05-01's `AiOutput` type landing in the same sprint.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
