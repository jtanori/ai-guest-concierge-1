---
id: S07-02
title: AI disclosure + 'talk to a person'
sprint: S07
epic: S07 - Chat hardening
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S06-02]
labels: [sprint:S07, track:foundation, prio:P0]
milestone: S07 - Chat hardening
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/80
pickup: ready
approved: 2026-10-25
done: 2026-10-25
---

# S07-02 — AI disclosure + 'talk to a person'

| | |
|---|---|
| Sprint | S07 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S06-02 |
| Pickup | `ready` |

## 1. Why / goal

Legal/ethical baseline: guests know it's AI and can reach a human in one tap from any state.

## 2. Acceptance criteria (backlog AC verbatim)

> A human is reachable in one tap from any state.

- **AC-1** First AI reply contains `guest.ai_disclosure` (ES+EN from the catalogue).
- **AC-2** One tap posts a handoff that works from `idle`, `awaiting_ai`, `awaiting_staff` and `resolved`.

## 3. Scope

**In:** Disclosure copy, handoff button/route, handoff state transition.

**Out:** Staff inbox rendering (S08-01); notification delivery (S09-05).

## 4. Calculated changes (for the coding agent)

- Use the existing `t('guest.ai_disclosure', lang)` and `t('guest.talk_to_person', lang)` from `src/i18n/catalog.ts` — **no new copy outside the catalogue** (D14).
- `POST /api/chat/handoff`: call `transition(..., 'awaiting_staff')` from `src/conversation/state.ts`, insert a `handoff_reasons` row with `reason_code='guest_asked_human'`, emit `human_takeover`, create a `service_requests` row so S09-05 can notify even with no staff view.
- Render the button in the guest widget from S06-01; pressing it must succeed even if the AI provider is down (no provider call in this path).

## 5. Tenancy & security

Handoff writes use the guest-derived tenant context; `reason_code` is a closed enum — add a CHECK alongside the migration in S06-02 if not already present.

## 6. Test plan (named cases)

- `tests/db/handoff.db.test.ts`: handoff from all four states; no provider call; `human_takeover` + `request_created` events; disclosure present on first AI message in ES and EN.

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**Started 2026-10-25** after S06-02 merged (`8d4b31b`). §8's only blocker (DEC-1) closed on **React 19 + Next.js + Shadcn/UI + Tailwind**, so the widget markup is a React client component (`web/components/guest-chat.tsx`) sharing the `web/` design system; the API route stays in `src/` (the S06-01 surface decision).

Two deviations from §4, both deliberate:

- **`0017_handoff_from_resolved.sql` was needed.** §4 said to call `transition(..., 'awaiting_staff')`, but 0016's matrix had no `resolved -> awaiting_staff` edge — and AC-2 names `resolved` explicitly. The matrix widened; the reasoning is in §10 and in the migration header.
- **`takeover()` rather than a bare `transition()`.** It already writes `handoff_reasons` and emits `human_takeover` in one transaction with the state change, which is exactly what §4 asked for; a second implementation in the guest layer would have been a second copy of the same three statements.
## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview`, `web-build`, `eval`.
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs S07-02 "✅ Done (…)"`.
- [x] Cross-tenant isolation suite extended (no new table; the handoff route resolves its tenant from the slug exactly like the chat route, and `tests/db/handoff.db.test.ts` covers the unknown-slug case).
- [x] Review threads resolved; charter §9 decisions recorded in the runbook.

## 10. Outcome (2026-10-25)

**AC-1 met.** The first outbound message of a conversation is prefixed with `guest.ai_disclosure` (ES and EN, asserted separately), stored that way so the transcript staff read is the text the guest read, and not repeated on later turns. "First" is decided by a query under the conversation's row lock, so a guest who taps "talk to a person" before typing still gets it — that conversation exists with no messages in it.

**AC-2 met.** `POST /api/chat/handoff` reaches `awaiting_staff` from `idle`, `awaiting_ai`, `awaiting_staff` and `resolved`, and from the state a first-time visitor is in (no conversation yet); `tests/db/handoff.db.test.ts` drives each. On every path: **zero provider calls** (a provider that throws if asked proves it), one `handoff_reasons` row with `guest_asked_human`, one `human_takeover` event, one `request_created` event, one open `service_requests` row however many times the guest taps, and a re-issued cookie so the next message stays in the same thread.

**Changed a decided constraint, on purpose.** 0016 recorded `resolved -> awaiting_staff` as illegal. AC-2 requires it, and the AC is right: refusing a handoff because the row says "resolved" disables the guest's only route to a person at the moment the bot has given up. `0017` adds the edge to both copies of the matrix and keeps `resolved -> idle` illegal. The S06-02 charter's §10 reasoning is superseded on this one edge and cross-references 0017.

**Deliberately not done:** the staff inbox that shows the request (S08-01), email notification (S09-05), and the staff identity that `handoff_reasons` still cannot record — `takeover()` writes *why*, not *who*, until S08-01 supplies a session user.
