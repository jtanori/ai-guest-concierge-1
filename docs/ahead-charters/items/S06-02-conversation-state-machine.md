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
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/77
pickup: ready
approved: 2026-10-25
done: 2026-10-25
---

# S06-02 — Conversation state machine

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

- Migration `0016_conversation_state.sql` (the charter calculated 0014; 0014/0015 were taken by S05-03 and S06-01 — the charter says to rebase): `ALTER TABLE conversations ADD COLUMN ai_state text NOT NULL DEFAULT 'idle' CHECK (ai_state IN ('idle','awaiting_ai','awaiting_staff','resolved'))`; add `transition_guard()` trigger function with an explicit allowed-transition matrix (`idle→awaiting_ai|awaiting_staff`, `awaiting_ai→idle|awaiting_staff|resolved`, `awaiting_staff→resolved|awaiting_ai`, `resolved→awaiting_ai`) that `RAISE EXCEPTION` on anything else. Keep `conversations.status` (open/closed) as-is.
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

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview`, `web-build`.
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs S06-02 "✅ Done (…)"` — both ACs are objectively met and machine-verified.
- [x] Cross-tenant isolation unaffected (no new table); no new runtime dependency.
- [x] Review threads resolved; §10 records the outcome and the two copy-of-the-matrix decision.

## 10. Outcome (2026-10-25)

**AC-1 met.** `0016_conversation_state.sql` adds `conversations.ai_state` (`idle | awaiting_ai | awaiting_staff | resolved`), a `BEFORE UPDATE OF ai_state` trigger holding the allowed-transition matrix, and a partial index for the "who is waiting" queue. `tests/db/conversation-state.db.test.ts` walks all sixteen pairs of the grid through **raw SQL**: eight legal edges succeed, four illegal edges raise `P0001` and leave the row unchanged, four same-state writes are no-ops. The TypeScript copy (`src/conversation/state.ts`) is pinned to the SQL by execution, not by a comment.

**AC-2 met.** `takeover()` and every model write path take `SELECT … FOR UPDATE` on the same conversation row inside their own transaction, so the two are serialised: the test starts a takeover while another transaction holds the lock, asserts it has not completed while the lock is held, and asserts it completes exactly when that transaction commits. After a takeover, `assertModelMaySpeak` throws `StaffTookOverError`, and a real guest turn on an `awaiting_staff` conversation never reaches the provider (asserted: zero requests) — it records the guest's message and answers with the catalogue string `guest.staff_reply_pending`.

Evidence: 28 unit files / 381 tests, 23 db files / 204 tests, web build green.

**Deliberately not done:** the inbox UI that creates takeovers (S08-01), the hand-back UI (S08-03), the request status machine (S09-01). `takeover()` records *why* (reason code + detail) but not *who*: there is no staff identity on the conversation path until S08-01 supplies one, and inventing a fake actor here would have been worse than the gap.
