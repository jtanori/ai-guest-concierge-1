---
id: S09-01
title: Request lifecycle
sprint: S09
epic: S09 - Requests and notifications
track: Eng
estimate_days: 2.0
priority: P0
depends_on: [S07-03]
labels: [sprint:S09, track:foundation, prio:P0]
milestone: S09 - Requests and notifications
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/89
pickup: ready
---

# S09-01 — Request lifecycle

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S07-03 |
| Pickup | `ready` |

## 1. Why / goal

A request's acknowledgement timestamp must come from a real staff action, not from the bot.

## 2. Acceptance criteria (backlog AC verbatim)

> request_acknowledged is set by a real staff action.

- **AC-1** Legal transitions `new→acknowledged→assigned→resolved|cancelled` enforced at the DB level.
- **AC-2** `acknowledged_at` can only be set inside `withStaffSession` by a role allowed on `queue:write`.
- **AC-3** `request_acknowledged`, `request_assigned`, `request_resolved` events are emitted.

## 3. Scope

**In:** Lifecycle service, trigger, staff route, events.

**Out:** Email delivery (S09-05); knowledge-gap queue (S09-02).

## 4. Calculated changes (for the coding agent)

- Migration `0018_request_lifecycle.sql`: a `BEFORE UPDATE` trigger `request_transition_guard` on `service_requests` implementing the transition table; a second trigger `request_ack_guard` that rejects `acknowledged_at IS NOT NULL AND status = 'new'` and requires `app.current_user_id` (set by `withStaffSession`) to be non-empty when `acknowledged_at` changes — FK-style: `acknowledged_by uuid REFERENCES users(user_id)` added to the table and required when acknowledged.
- `src/requests/lifecycle.ts`: `transitionRequest(client, context, session, requestId, to)` — `SELECT ... FOR UPDATE`, assert role via `session.requireRole('queue','write')`, `UPDATE`, write `assignments` on assign, `writeAudit` (`request.assigned`/`request.resolved` — add to `src/audit/actions.ts`), `createEvent` for each transition.
- `src/audit/actions.ts`: add `request.acknowledged`, `request.assigned`, `request.resolved` and `request` to `ENTITY_TYPES`.
- Add `POST /staff/requests/:id/:action` with the same staff-session pattern as S08-03.

## 5. Tenancy & security

Trigger runs as owner — scope by `(org_id, property_id, request_id)`. `app.current_user_id` must be `SET LOCAL`, never a request field.

## 6. Test plan (named cases)

- `tests/db/request-lifecycle.db.test.ts`: each legal/illegal transition; raw SQL cannot set `acknowledged_at` without a session user; denied role writes nothing; event + audit row counts.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- ``npm test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — no external decision. Depends on S07-03's `service_requests` rows and S02-01's `withStaffSession`.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
