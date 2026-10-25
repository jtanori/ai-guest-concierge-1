---
id: S11-01
title: Transactional outbox + worker + DLQ
sprint: S11
epic: S11 - Reliability
track: Eng
estimate_days: 1.5
priority: P0
depends_on: [S06-01]
labels: [sprint:S11, track:foundation, prio:P0]
milestone: S11 - Reliability
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/97
pickup: ready
---

# S11-01 — Transactional outbox + worker + DLQ

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S11 |
| Track / days / priority | Eng · 1.5d · P0 |
| Depends on | S06-01 |
| Pickup | `ready` |

## 1. Why / goal

Provider outage causes delayed sends, not lost messages (D7).

## 2. Acceptance criteria (backlog AC verbatim)

> Provider outage delays sends, never loses them.

- **AC-1** Message + outbox row are written in one transaction.
- **AC-2** Worker claims with `FOR UPDATE SKIP LOCKED`, retries with backoff, and moves to `dead` after N attempts.
- **AC-3** Two workers never double-send.

## 3. Scope

**In:** Worker, claim loop, backoff, DLQ, provider port.

**Out:** Webhook dedupe (S11-02); alerts (S11-04).

## 4. Calculated changes (for the coding agent)

- `outbox` table exists in 0001 with `kind, payload, status, attempts, next_attempt_at, last_error, processed_at` and a partial `outbox_pending` index — **no new table needed**.
- `src/outbox/worker.ts`: `claimBatch(client, limit)` → `UPDATE outbox SET status='sending' WHERE outbox_id IN (SELECT outbox_id FROM outbox WHERE status IN ('pending','failed') AND next_attempt_at <= now() ORDER BY outbox_id FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING *`; `process(row, providers)` switches on `kind`; on failure increment `attempts`, set `next_attempt_at = now() + (2^attempts * interval '30 seconds')`, `last_error`, status `failed` or `dead` after 6 attempts; on success `status='sent', processed_at=now()`.
- Provider port `interface OutboxSender { send(kind, payload): Promise<void> }` — S09-05 (email), WA-03 (WhatsApp), DF-01 (webhook) register handlers; a fake throws deterministically in CI.
- `scripts/worker.ts` + `"worker": "node --experimental-strip-types scripts/worker.ts"`; run one worker locally and in staging; add `outbox` to the isolation suite (rows carry tenant ids).

## 5. Tenancy & security

Worker sets `app.current_org_id/property_id` from each row before any tenant-table read; never processes a row with missing tenant ids (`CHECK` in `0023_outbox.sql`).

## 6. Test plan (named cases)

- `tests/db/outbox.db.test.ts`: 100 rows + always-failing provider → 0 lost (all `pending|failed|dead`), two workers → exactly one send each, backoff schedule, `dead` after 6, replay of a `sent` row is a no-op.
- `tests/outbox/worker.test.ts`: pure backoff function.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- ``npm test``
- `staging outage simulation transcript`

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — table + index already exist. Depends on S06-01 only for the first producer.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
