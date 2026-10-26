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
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/87
pickup: done
---

# S08-03 — Reply, take over, assign, resolve

> **DONE (2026-10-26), shipped in PR #143.** The interesting part of this item was
> not the four actions — it was discovering that the existing lock could not
> deliver AC-2 at all. See §10.
>
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

**CLOSED.** One decision was made before any code was written, and one was made
against the charter's own plan after the first version failed its own race test.

- **DEC-1 (UI rendering) — resolved by precedent.** Server actions on the detail
  page (S08-01's pattern: React server components, forms, HttpOnly session). No
  client-side mutation code, so no token in the browser.
- **DEC-2 (lock strength) — the charter's `FOR UPDATE` for both sides does not
  work.** Detailed in §10; the short version is that a guest turn's inbound
  message takes a `FOR KEY SHARE` lock on the conversation row, and `FOR UPDATE`
  conflicts with it, so a takeover waits behind the model call — the exact race
  AC-2 forbids, seen from the agent's side.

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [x] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval. (No new dependency; the cross-tenant action cases are named tests.)
- [x] Review threads resolved; charter §9 decisions recorded in the runbook.

## 10. Close-out

**AC-1 — take over, reply, assign and resolve are atomic under a row lock.** Met.

Every action starts by locking the conversation row and re-reading `ai_state`
from the locked row, never from the copy the route read a moment earlier. Reply
takes over *first*, in the same transaction, because doing it afterwards leaves a
window where the model answers and then a human answers the same question.
Assignment is guarded by a unique index rather than a SELECT-then-INSERT, so two
agents in the same millisecond produce one assignment (the second sees
`created: false`). Resolve closes the conversation **and every open request on
it** — a request left `assigned` on a resolved thread is the row S08-01's
`unresolved` filter exists to surface.

**AC-2 — an AI writer that started before a takeover loses deterministically.
The charter's plan did not achieve this, and the first implementation passed a
naive test that proved nothing.**

S06-02 held the conversation row lock for the *whole* guest turn, model call
included. That is mutually exclusive with a takeover, but in the wrong
direction: the human waits for the model, and the turn that started first speaks
last. Worse, simply *not* taking the lock early is not enough — inserting the
guest's inbound message takes a `FOR KEY SHARE` lock on the conversation (its
foreign key), and `FOR UPDATE` conflicts with `FOR KEY SHARE`. So a staff action
still blocked behind the provider call.

The fix is a lock-strength pair, not a lock:

| writer | lock | why |
|---|---|---|
| staff actions (`src/inbox/actions.ts`) | `FOR NO KEY UPDATE` | compatible with the guest turn's `FOR KEY SHARE`, so a takeover lands mid-model-call; still conflicts with itself, so two agents serialise |
| AI pre-write check (`assertModelMaySpeak`) | `FOR UPDATE` | waits for a committing takeover, then observes `awaiting_staff` and aborts |

The guest pipeline (`src/guest/service.ts`) now reads `ai_state` **without** a
lock before calling the model, and calls `assertModelMaySpeak` — which takes
`FOR UPDATE` — after the model returns. When a takeover won in between, the
model's answer is discarded, the guest receives the catalogue's "a person will
reply" line instead, and a `needs_human` request is opened so the promise has a
row behind it. The `ai_runs` row stays: the model did work and did cost money.

`tests/db/takeover-race.db.test.ts` is the proof, and it is written so that the
S06-02 shape fails loudly: a scripted provider parks inside `generate`, the
takeover runs on a **second connection** while the first is still thinking, and
the assertion is that the takeover commits within 3s (if it blocked, the test
errors) and that exactly one outbound message exists afterwards — the pending
line, never the model's answer.

**Migration 0023.** Two constraints the actions assume, plus one vocabulary
word:

- `assignments_request_assignee` unique on `(org_id, property_id, request_id,
  assigned_to)`. **Deviation from §4:** the charter's version included
  `created_at`, which cannot stop a replay — `created_at` defaults to `now()`, so
  a retried request inserts a second, different-looking row.
- `service_requests_acknowledged_shape`: `acknowledged_at IS NULL OR status <>
  'new'`. Nothing is backfilled — inventing an acknowledgement time would fake
  the metric it feeds.
- `handoff_reasons.reason_code` gains `staff_takeover`. Recording a proactive
  human takeover as `guest_asked_human` would corrupt the metric about guests,
  so the vocabulary grows by one honest word instead.

**Route shape.** `POST /api/inbox/conversations/:id/{takeover,reply,assign,resolve}`
through the shared staff pipeline (`queue: write`; the observer is 403 on all
four). Status mapping is the existing one function: 400 invalid, 403 role, 404
foreign/unknown, 409 conflict (`assignee_not_member`, `request_not_open`,
`illegal_transition`).

**The UI is three forms.** Server actions (`web/app/(staff)/inbox/[conversationId]/actions.ts`)
post to the API; the page renders a reply box, take over, assign-to-me and resolve.
The buttons are a courtesy — the role check is the API's. "Assign to me" is the
only assignment offered: choosing a colleague needs a staff picker, which is a
settings surface, and the API already accepts any `assigneeUserId`.

**Not done, by scope:** operating modes (S08-04), notification email (S09-05),
internal notes, and reassignment to another user from the UI.

**Evidence:**

- `npm run db:migrate` — **23 applied** (0023).
- `npm run db:test` — **32 files / 272 passed** (2 race cases, 9 action cases).
- `npx vitest run` — **41 files / 523 passed** (5 pure action cases, 5 page cases).
- `npx tsc --noEmit` and `npm run lint` clean, root and `web/`.
- `npm run web:build` green; `/inbox/[conversationId]` still in the manifest.
