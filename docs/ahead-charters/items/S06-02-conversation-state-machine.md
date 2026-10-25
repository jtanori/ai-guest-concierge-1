---
id: S06-02
title: Conversation state machine
sprint: S06
epic: S06 - Guest chat and evaluation
track: Eng
estimate_days: 1.5
priority: P0
depends_on: [S06-01]
labels: [sprint:S06, track:foundation, prio:P0]
milestone: S06 - Guest chat and evaluation
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/77
pickup: ready
---

# S06-02 — Conversation state machine

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S06 |
| Track / days / priority | Eng · 1.5d · P0 |
| Depends on | S06-01 |
| Pickup | `ready` |

## 1. Why / goal

Make illegal transitions impossible at the database level, including raw SQL.

## 2. Acceptance criteria (backlog AC verbatim)

> Illegal transitions impossible at the database level.

- **AC-1** A `BEFORE UPDATE` trigger rejects any state transition not in the allowed table.
- **AC-2** `takeover` is atomic: AI cannot reply after a staff takeover (feeds S08-03).

## 3. Scope

**In:** State column, trigger, transition service, atomic takeover.

**Out:** Inbox UI (S08-01); request status machine (S09-01).

## 4. Calculated changes (for the coding agent)

- Migration `0014_conversation_state.sql`: `ALTER TABLE conversations ADD COLUMN ai_state text NOT NULL DEFAULT 'idle' CHECK (ai_state IN ('idle','awaiting_ai','awaiting_staff','resolved'))`; add `transition_guard()` trigger function with an explicit allowed-transition matrix (`idle→awaiting_ai|awaiting_staff`, `awaiting_ai→idle|awaiting_staff|resolved`, `awaiting_staff→resolved|awaiting_ai`, `resolved→awaiting_ai`) that `RAISE EXCEPTION` on anything else. Keep `conversations.status` (open/closed) as-is.
- `src/conversation/state.ts`: `TRANSITIONS` constant (mirrors the trigger), `assertTransition(from, to)` for unit-level early failure, and `transition(client, context, conversationId, to)` doing `SELECT ... FOR UPDATE` then UPDATE — the row lock is what makes takeover atomic.
- `takeover()`: `SELECT ai_state FROM conversations WHERE ... FOR UPDATE` → assert `ai_state <> 'resolved'` → set `awaiting_staff` → insert `handoff_reasons` + `conversation.takeover` audit row; an AI writer must re-read `ai_state` under the same lock before inserting its outbound message.
- Register `conversations` new column in `tests/db/schema.db.test.ts` (column assertions) and the migration count in `tests/db/non-superuser.db.test.ts` (currently 9).

## 5. Tenancy & security

Trigger runs as the table owner and bypasses RLS — it must not read or write across tenants; scope every statement by `(org_id, property_id, conversation_id)`.

## 6. Test plan (named cases)

- `tests/db/conversation-state.db.test.ts`: each legal transition succeeds; each illegal one fails with 23514 or `P0001`; raw SQL cannot bypass; concurrent takeover vs AI reply → exactly one winner.
- `tests/conversation/state.test.ts`: pure matrix + unreachable states.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- ``npm test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — calculable now; no external decision. Depends only on S06-01's conversation rows existing.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
