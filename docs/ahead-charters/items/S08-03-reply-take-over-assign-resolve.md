---
id: S08-03
title: Reply, take over, assign, resolve
sprint: S08
epic: S08 - Staff inbox
track: Eng
estimate_days: 1.5
priority: P0
depends_on: [S08-01]
labels: [sprint:S08, track:foundation, prio:P0]
milestone: S08 - Staff inbox
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/87
pickup: decision
---

# S08-03 — Reply, take over, assign, resolve

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S08 |
| Track / days / priority | Eng · 1.5d · P0 |
| Depends on | S08-01 |
| Pickup | `decision` |

## 1. Why / goal

No race where AI replies after a takeover.

## 2. Acceptance criteria (backlog AC verbatim)

> No race where AI replies after a takeover.

- **AC-1** Takeover, reply, assign and resolve are atomic under a `FOR UPDATE` conversation lock.
- **AC-2** An AI writer that started before a takeover loses the race deterministically.

## 3. Scope

**In:** Staff actions, atomic state guard, assignment/status writes, events + audit.

**Out:** Operating modes (S08-04); email notification (S09-05).

## 4. Calculated changes (for the coding agent)

- `src/inbox/actions.ts`: `reply`, `takeover`, `assign`, `resolve` — each begins `SELECT ai_state FROM conversations WHERE ... FOR UPDATE`, re-checks state via `src/conversation/state.ts`, then writes. AI writers (`src/ai/answer.ts`) must acquire the **same row lock** before inserting an outbound message, so one of them sees `ai_state='awaiting_staff'` and aborts.
- Writes: `messages(direction='outbound', author_role='staff')`, `assignments`, `service_requests.status`, `conversations.ai_state`, `handoff_reasons`; audit rows `conversation.takeover` and `message.sent` (already in `src/audit/actions.ts`); events `staff_message_sent`, `human_takeover`, `request_assigned`, `request_resolved` (`src/events/taxonomy.ts`).
- Migration `0017_staff_actions.sql`: `UNIQUE (org_id, property_id, request_id, assigned_to, created_at)` guard on `assignments` to stop duplicate assignment replays; CHECK that `service_requests.acknowledged_at` is null unless `status <> 'new'` (shared with S09-01).
- All actions require `session.requireRole('queue','write')`; `observer` is read-only by the S02-01 matrix.

## 5. Tenancy & security

Every UPDATE includes `(org_id, property_id, conversation_id)`; add a cross-tenant action test.

## 6. Test plan (named cases)

- `tests/db/takeover-race.db.test.ts`: two connections, AI reply vs takeover → exactly one outbound message and no AI message after the takeover timestamp.
- `tests/inbox/actions.test.ts`: each role's allow/deny, duplicate assignment replay is a no-op.

## 7. Evidence to record in the runbook

- ``npm run db:test` (race case with two connections)`
- ``npm test``

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-1 (UI rendering).** Concurrency contract, SQL, audit and events are fully calculated.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
