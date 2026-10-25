---
id: S09-02
title: Knowledge-gap queue
sprint: S09
epic: S09 - Requests and notifications
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S05-02]
labels: [sprint:S09, track:foundation, prio:P0]
milestone: S09 - Requests and notifications
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/90
pickup: ready
---

# S09-02 — Knowledge-gap queue

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S05-02 |
| Pickup | `ready` |

## 1. Why / goal

Every no-answer must land in a queue so the content owner knows what to write next.

## 2. Acceptance criteria (backlog AC verbatim)

> Every no_answer lands in the queue automatically.

- **AC-1** Each `no_answer` creates/updates one `knowledge_gaps` row with the verbatim question, language and property.
- **AC-2** Close produces `knowledge_gap_closed`; median age is computable.

## 3. Scope

**In:** Gap upsert, queue query, close action, median-age metric.

**Out:** Gap analytics tile (S10-03).

## 4. Calculated changes (for the coding agent)

- `knowledge_gaps` already exists in 0001 (`gap_id, conversation_id, question, language, status, created_at, resolved_at`). Add `src/gaps/queue.ts`: `recordGap` (dedupe on `(property_id, lower(question))` within 7 days via a partial unique index in `0019_gaps.sql`), `listOpenGaps`, `closeGap(client, context, gapId)` setting `resolved_at` + `status='resolved'`.
- Migration `0019_gaps.sql`: `CREATE UNIQUE INDEX knowledge_gaps_open_question ON knowledge_gaps (property_id, lower(question)) WHERE status='open'`; index `(property_id, status, created_at)`; add `topic text` and `hits integer NOT NULL DEFAULT 1` so repeats increment rather than spam the queue.
- `src/gaps/metrics.ts`: `medianOpenAgeDays(client, context)` — a pure SQL `percentile_cont(0.5) within group (order by extract(epoch from now()-created_at))` (target ≤7 days, Appendix D).
- Emit `knowledge_gap_created` / `knowledge_gap_closed` via `createEvent`.

## 5. Tenancy & security

Dedupe key includes `property_id`; add `knowledge_gaps` to the isolation sweep.

## 6. Test plan (named cases)

- `tests/db/gaps.db.test.ts`: duplicate question increments hits (one row); close sets `resolved_at`; median age computation; cross-tenant isolation.

## 7. Evidence to record in the runbook

- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
