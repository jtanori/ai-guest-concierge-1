---
id: S09-03
title: One-click 'wrong or outdated'
sprint: S09
epic: S09 - Requests and notifications
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S08-02, S05-03]
labels: [sprint:S09, track:foundation, prio:P0]
milestone: S09 - Requests and notifications
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/91
pickup: ready
---

# S09-03 — One-click 'wrong or outdated'

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S08-02, S05-03 |
| Pickup | `ready` |

## 1. Why / goal

A flag is attributable to the exact `ai_run` that produced the answer.

## 2. Acceptance criteria (backlog AC verbatim)

> A flag is attributable to an ai_run.

- **AC-1** One click creates a flag row with `ai_run_id`, staff user id, timestamp and optional note.
- **AC-2** The flag is visible on the conversation detail view and emits `answer_flagged_wrong`.

## 3. Scope

**In:** Flag table, route, event, detail-view indicator.

**Out:** Review queue (S09-04); retraining/automated fixes.

## 4. Calculated changes (for the coding agent)

- Migration `0020_answer_flags.sql`: `answer_flags(org_id, property_id, flag_id uuid PK, ai_run_id uuid NOT NULL, flagged_by uuid NOT NULL REFERENCES users, note text, created_at timestamptz DEFAULT now(), UNIQUE (org_id,property_id,ai_run_id,flagged_by), composite FK → ai_runs)` + FORCE RLS + policy + grants.
- `src/inbox/flags.ts`: `flagAnswer(client, context, session, aiRunId, note?)` — `session.requireRole('queue','write')`, verify the `ai_run` is visible in this tenant, insert, `createEvent('answer_flagged_wrong', {ai_run_id})`.
- Wire the `data-ai-run-id` hook from S08-02 into `POST /staff/answers/:aiRunId/flag`; add `staff.flag.*` catalogue strings (ES+EN).

## 5. Tenancy & security

Composite FK prevents citing another tenant's `ai_run`; add to isolation + schema suites.

## 6. Test plan (named cases)

- `tests/db/flags.db.test.ts`: flag attributable, one per user/run, foreign `ai_run_id` → not found, event emitted.

## 7. Evidence to record in the runbook

- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — depends on S08-02's detail view and S05-03's `ai_runs` rows.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
