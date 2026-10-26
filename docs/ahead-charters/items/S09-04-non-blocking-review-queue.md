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
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/92
pickup: done
---

# S09-04 — Non-blocking review queue

> **Approved to start by the user on 2026-10-26** as part of the S09-01…S09-05 sequence. The draft notice below is retained for provenance; §4 was rebased on the merged baseline and the deviations are recorded in §8 and in the runbook.

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S08-03 |
| Pickup | `done` (2026-10-26) |

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

**DONE — user approved the S09 sequence on 2026-10-26.** As §8 anticipated, a minimal claim loop is implemented here (`processReviewOutbox`) and S11-01 hardens it.

Deviations from §4, all recorded in the runbook:

- **Migration is `0027`, not `0021`.** `0021_inbox_indexes.sql` exists.
- **The `kind` CHECK is widened in 0027**, as §4 described, but the migration also has to give the worker role its own RLS policy — see the next point, which §4 did not anticipate.
- **`SECURITY DEFINER` does not bypass RLS.** §5 says "worker must set GUCs from the row's org_id/property_id before processing", which assumes the worker can *read* the row first. It cannot: `outbox` is FORCE RLS whose tenant policy reads `current_org_id()`, and at claim time no tenant GUC is set. BYPASSRLS needs a superuser Neon does not give us (0015 says so explicitly), so the claim is a SECURITY DEFINER function owned by a new NOLOGIN `concierge_worker` role **with its own permissive policy on `outbox`**, split SELECT/UPDATE rather than one FOR ALL. Contained the way 0015 contains `concierge_public`.
- **Disposition is `answer_reviews`, keyed by `(org_id, property_id, ai_run_id)`** — §4 offered "a `reviewed_at` column on `ai_runs` **or** an `ai_run_reviews` table"; the table won, because a mutable column on `ai_runs` would put review state inside the row every accuracy metric reads.
- **§4's `needs_review` rule cannot exist.** §4 did not name one, and the obvious candidate — "needs review in `draft` mode", which is what S08-04's wording suggests — can never be true: draft mode escalates with **zero provider calls**, so there is no `ai_runs` row to dispose of. Draft mode's queue is the inbox. The shipped rule reads `ai_runs.decision`, which the pipeline already writes: `escalate` needs a human, `answer` does not, and `no_answer` belongs to S09-02's gap queue rather than to a second queue for the same fact.
- **No timing test as §4 specified it.** §4 asked for "the delta must be <10ms with and without a failing review worker". A wall-clock delta under 10ms is not a property this can guarantee on shared CI hardware, and it would flake. What is asserted instead is the thing the timing was a proxy for: the reply is committed and visible from another session while the review row is still `pending` with `processed_at IS NULL` and no disposition written — i.e. the review work provably has not started. Ordering, not microseconds.
- **Nothing schedules the worker yet.** `processReviewOutbox` is implemented and tested but is not started from `src/server.ts`: S11-01 owns the worker's lifecycle (interval, shutdown, concurrency, a reaper for rows stranded in `sending`). This loop never writes `sending`, so it cannot strand one.

## 9. Definition of done

- [x] Implemented and measured locally: `db:migrate` 27 from empty, `db:test` 37 files / 368, `npm test` 46 files / 576, root+web `tsc` clean, `lint` clean, `web:build` green. Runbook entry `## S09-04 - Non-blocking review queue (0.50d)`.
- [x] Cross-tenant isolation suite extended for `answer_reviews` (declared, seeded in both tenants, swept both directions); `tests/db/non-superuser.db.test.ts` extended to cover the new `concierge_worker` definer role, which is what caught the ownership-transfer failure. ERD updated. No new runtime dependency.
- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
