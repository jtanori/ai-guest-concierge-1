---
id: S08-01
title: Phone-first shared inbox
sprint: S08
epic: S08 - Staff inbox
track: Eng
estimate_days: 2.0
priority: P0
depends_on: [S06-02]
labels: [sprint:S08, track:foundation, prio:P0]
milestone: S08 - Staff inbox
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/85
pickup: decision
---

# S08-01 — Phone-first shared inbox

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S08 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S06-02 |
| Pickup | `decision` |

## 1. Why / goal

The surface staff actually use — triage a queue on a phone in under 60 seconds.

## 2. Acceptance criteria (backlog AC verbatim)

> An agent triages a queue on a phone in under 60 seconds.

- **AC-1** `GET /staff/inbox` shows needs-attention / mine / unresolved filters with last message + wait time.
- **AC-2** Every query is tenant-scoped and paged; p95 read <300ms at fixture scale.

## 3. Scope

**In:** Inbox queries, indexes, server-rendered mobile view, staff auth.

**Out:** Reply/takeover actions (S08-03); AI sources pane (S08-02).

## 4. Calculated changes (for the coding agent)

- `src/inbox/queries.ts`: `listInbox(client, context, {filter, limit, cursor})` — a single SQL over `conversations` joined to a lateral last-message, filtered by `ai_state`, `assignments.assigned_to`, and `service_requests.status`; keyset pagination on `(last_activity_at, conversation_id)`.
- Migration `0016_inbox_indexes.sql`: `CREATE INDEX conversations_inbox ON conversations (property_id, ai_state, last_activity_at DESC)`, `CREATE INDEX messages_conversation_time ON messages (org_id, property_id, conversation_id, created_at DESC)`, `CREATE INDEX assignments_user ON assignments (assigned_to, created_at DESC)`.
- Routes under `/staff/*` require `withStaffSession` + `session.requireRole('queue','read')` (`src/auth/context.ts`) — this also exercises the S02-06 guard in production.
- Use only existing `staff.inbox.*` strings from `src/i18n/catalog.ts`; add new ids in both languages. Server-rendered HTML by default (DEC-1).

## 5. Tenancy & security

All three filters must include `org_id = $1 AND property_id = $2` explicitly in addition to RLS; add the inbox query to the cross-tenant isolation suite.

## 6. Test plan (named cases)

- `tests/db/inbox.db.test.ts`: each filter returns only that tenant's rows; paging stable under a new message; 60s triage timing test on the fixture.
- `tests/http/inbox.test.ts`: unauthenticated → 401; `observer` → 403.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- `Lighthouse/phone screenshot in runbook`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-1 (UI framework)** — queries, indexes and auth are fully calculated; markup waits on the framework decision.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
