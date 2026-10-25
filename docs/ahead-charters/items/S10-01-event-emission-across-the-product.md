---
id: S10-01
title: Event emission across the product
sprint: S10
epic: S10 - Analytics
track: Eng
estimate_days: 1.5
priority: P0
depends_on: [W00-19]
labels: [sprint:S10, track:foundation, prio:P0]
milestone: S10 - Analytics
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/94
pickup: ready
---

# S10-01 — Event emission across the product

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S10 |
| Track / days / priority | Eng · 1.5d · P0 |
| Depends on | W00-19 |
| Pickup | `ready` |

## 1. Why / goal

One append-only `events` table (D10) — dashboard numbers must reconcile exactly to raw events.

## 2. Acceptance criteria (backlog AC verbatim)

> Dashboard numbers reconcile exactly to raw events.

- **AC-1** All 18 canonical events (plan Appendix C / `src/events/taxonomy.ts`) are emitted from production paths, not just tests.
- **AC-2** Every event carries `org_id, property_id, conversation_id, channel, language, topic, created_at`.
- **AC-3** A seeded set of 100 actions produces exactly 100 matching event rows.

## 3. Scope

**In:** Event writer, instrumentation of S04–S09 paths, reconciliation test.

**Out:** Rollups (S10-02); dashboard (S10-03).

## 4. Calculated changes (for the coding agent)

- `src/events/emit.ts`: `emitEvent(client, context, type: EventName, data)` — validate with `isEventName` + `createEvent` (`src/events/taxonomy.ts`, already holds the canonical 18 under a contract test) and `INSERT INTO events (...)` in the caller's transaction. Never emit outside a tenant transaction.
- Instrument: `conversation_started`/`message_received` (S06-01), `ai_run_completed`/`ai_answer_sent`/`ai_escalated`/`no_answer_emitted` (S05-01/02, S07-05), `human_takeover`/`staff_message_sent` (S07-02, S08-03), `request_*` (S09-01), `answer_flagged_wrong` (S09-03), `knowledge_gap_*` (S09-02), `booking_link_clicked` (S07-01 or guest widget), `outbound_webhook_delivered` (DF-01/WA), `message_failed` (S07-05/S11-01).
- Migration `0022_events_hardening.sql`: `ALTER TABLE events ADD CONSTRAINT events_payload_object CHECK (jsonb_typeof(payload)='object')`; index `(property_id, event_type, created_at DESC)`; `REVOKE UPDATE, DELETE ON events FROM concierge_app` (append-only, same pattern as 0007's `audit_log`).
- Add `src/events/reconcile.ts`: `reconcile(client, context, window)` — count business rows (conversations/messages/ai_runs/requests) vs the corresponding event types and return per-metric deltas; assert all zero in the DB test.

## 5. Tenancy & security

Events are the analytics source of truth; `REVOKE UPDATE/DELETE` + FORCE RLS. `createEvent` already refuses a context-less event.

## 6. Test plan (named cases)

- `tests/db/events.db.test.ts`: 100 seeded actions → exact event counts; no UPDATE/DELETE possible as `concierge_app`; every event has all seven context fields; `staff_message_sent` present for repeated staff replies.
- `src/events/taxonomy.test.ts` (exists) pins the 18 names.

## 7. Evidence to record in the runbook

- ``npm run db:test` (reconciliation deltas = 0)`
- ``npm test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — the taxonomy module and table already exist. This is instrumentation + an append-only grant.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.

## Limited package authorization

See [parallel-work approval](../approvals/parallel-work.md). Only `S10-01-A` is owner-authorized, effective after the documentation PR merges. This parent charter remains draft and its full AC is unchanged.
