---
id: S09-04
title: Non-blocking review queue
sprint: S09
epic: S09 - Requests and notifications
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S08-03]
labels: [sprint:S09, track:foundation, prio:P0]
milestone: S09 - Requests and notifications
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/92
pickup: ready
---

# S09-04 — Non-blocking review queue

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S08-03 |
| Pickup | `ready` |

## 1. Why / goal

Flagging an answer must not delay the guest's reply.

## 2. Acceptance criteria (backlog AC verbatim)

> Flagging an answer does not delay the guest reply.

- **AC-1** The outbound guest message is committed before any review/flag work starts.
- **AC-2** Review work is retried from the outbox on failure; a failure never re-sends the guest message.

## 3. Scope

**In:** Outbox-based review enqueue, timing test.

**Out:** Email notifications (S09-05); outbox worker itself (S11-01).

## 4. Calculated changes (for the coding agent)

- `src/review/queue.ts`: `enqueueReview(client, context, {aiRunId, conversationId})` inserts an `outbox` row with `kind='webhook'` (or a new `kind='review'` — extend the CHECK in `0021_review_outbox.sql`) **in the same transaction as the answer**, but processing happens after commit by the S11-01 worker.
- Migration `0021_review_outbox.sql`: `ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check; ADD CONSTRAINT ... CHECK (kind IN ('provider_message','webhook','email','sms','review'))` — keep it as an additive migration, no backfill.
- Add a `reviewed_at` column to `ai_runs` (or a `ai_run_reviews` table) so the worker is idempotent; unique key `ai_run_id`.
- **Timing test**: measure `answerMessage` latency with and without a failing review worker — the delta must be <10ms and the guest message row must exist before the worker runs.

## 5. Tenancy & security

Outbox rows are tenant-scoped; worker must set GUCs from the row's `org_id/property_id` before processing.

## 6. Test plan (named cases)

- `tests/db/review-queue.db.test.ts`: guest message committed first; worker failure leaves the reply intact and the outbox row pending; replay is idempotent.

## 7. Evidence to record in the runbook

- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — depends on S08-03's staff actions and S11-01's worker (implement a minimal claim loop here and let S11-01 harden it).

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
