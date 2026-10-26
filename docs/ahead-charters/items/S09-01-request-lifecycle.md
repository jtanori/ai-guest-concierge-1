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
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/89
pickup: done
---

# S09-01 — Request lifecycle

> **Approved to start by the user on 2026-10-26.** Implementation baseline: `bb6c9f9` (S08 complete). The historical calculated changes below are superseded where noted in §8; completion still requires measured evidence.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S07-03 |
| Pickup | `done` (2026-10-26) |

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

- Migration `0024_request_lifecycle.sql`: a `BEFORE UPDATE` trigger `request_transition_guard` on `service_requests` implementing the transition table; a second trigger `request_ack_guard` that rejects `acknowledged_at IS NOT NULL AND status = 'new'` and requires `app.current_user_id` (set by `withStaffSession`) to be non-empty when `acknowledged_at` changes — FK-style: `acknowledged_by uuid REFERENCES users(user_id)` added to the table and required when acknowledged.
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

**IN PROGRESS — user approved start on 2026-10-26; S07-03 is merged.**

Open decisions / blockers:

- No external decision blocks kickoff. Uses S07-03's `service_requests` and S02-01's `withStaffSession`.
- Baseline has migrations through 0023; reserve **0024** for this item. Other parallel work must use the next available number, not the stale numbers in draft charters.
- Use current `emitEvent` and `StaffSession.requireRole("queue", "write")` APIs, not draft `createEvent` signatures.
- Integrate existing `src/inbox/actions.ts` Assign/Resolve writers: they currently skip stages (`new → assigned`, open → resolved). Do not add a trigger while leaving those production writers incompatible. Any intermediate acknowledgement must be performed by the authenticated staff action, never by the guest/AI pipeline. **Resolved:** both now walk the edges through `transitionRequest`; the intermediate acknowledgement is attributed to the authenticated caller, and `tests/db/inbox-actions.db.test.ts` still passes with its event assertion widened to `[request_acknowledged, request_assigned]`.
- Preserve conversation-first lock ordering and the S08-03 `FOR NO KEY UPDATE` conversation lock. Request transitions lock the request row and scope all reads/writes by org + property.
- DB guard must validate the current actor's property membership and queue-write permission, not merely a nonempty user GUC; reject spoofed acknowledgement attribution and changes to an existing acknowledgement.
- Inspect existing rows before deciding migration handling; never fabricate a historical staff actor to satisfy a new constraint.
- Add route-level denial/isolation tests and regression coverage for existing Assign/Resolve, alongside legal/illegal SQL transitions, immutable acknowledgement provenance, events/audits, and rollback. **Resolved:** all shipped in `tests/db/request-lifecycle.db.test.ts`. Provenance immutability was *narrowed* rather than implemented as drafted — see the runbook's deviation 2.
- Parallel coding candidate: S09-03 (merged prerequisites), with coordinated migration allocation and shared staff dispatcher edits. S09-02 remains conditional on S05-02's partial status. S09-05 provider/sender/fallback decisions can proceed now; implementation depends on this item.

## 9. Definition of done

- [x] Implemented and measured locally: `db:migrate` 24 from empty, `db:test` 34 files / 315, `npm test` 44 files / 562, root+web `tsc` clean, `lint` clean, `web:build` green. Runbook entry `## S09-01 - Request lifecycle (2.00d)`.
- [x] Deviations from §4/§8 recorded in the runbook: one trigger rather than two (0018 already owns the timestamp shape and its `P0001`); `acknowledged_by` is not frozen after the edge because the audit row is the immutable record (S08-04 precedent); route is `/api/inbox/requests/:id/:action`, not `/staff/...`.
- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
