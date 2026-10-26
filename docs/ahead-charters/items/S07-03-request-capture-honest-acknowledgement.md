---
id: S07-03
title: Request capture + honest acknowledgement
sprint: S07
epic: S07 - Chat hardening
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S06-02]
labels: [sprint:S07, track:foundation, prio:P0]
milestone: S07 - Chat hardening
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/81
pickup: ready
approved: 2026-10-25
done: 2026-10-25
---

# S07-03 — Request capture + honest acknowledgement

| | |
|---|---|
| Sprint | S07 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S06-02 |
| Pickup | `ready` |

## 1. Why / goal

The product must never claim a request is fulfilled.

## 2. Acceptance criteria (backlog AC verbatim)

> No code path can claim a request is fulfilled.

- **AC-1** A request creates `service_requests` + `knowledge_gaps` (for no-answer) in the same transaction as the acknowledgement message.
- **AC-2** A banned-phrase test scans every outbound template for fulfilment claims.

## 3. Scope

**In:** Capture service, acknowledgement copy, banned-phrase test.

**Out:** Lifecycle transitions (S09-01); email delivery (S09-05).

## 4. Calculated changes (for the coding agent)

- `src/requests/capture.ts`: `captureRequest(client, context, {conversationId, topic, question, language})` → `INSERT service_requests (status='new')`, `INSERT knowledge_gaps (status='open')` on `no_answer`, `INSERT messages (direction='outbound', author_role='ai', body=t('guest.request_ack',lang))`, `createEvent('request_created')`, `createEvent('knowledge_gap_created')` — one transaction.
- Add `guest.request_ack` and `guest.request_failed` to `src/i18n/catalog.ts` in **both** languages; copy must be ('we've passed this to the team', never 'done'/'confirmed'/'on the way'/'booked').
- `tests/requests/honesty.test.ts`: a regex denylist (`\b(confirmed|booked|on the way|we have a room|completado|confirmado|reservado)\b`) applied to every catalogue string used in outbound AI messages and to the rendered acknowledgement.
- Add a `service_requests` trigger: `acknowledged_at` may only be set together with `status='acknowledged'` (S09-01 owns the staff action that sets it).

## 5. Tenancy & security

Request rows are tenant-scoped; add `service_requests`/`knowledge_gaps` to the isolation sweep if not already enumerated.

## 6. Test plan (named cases)

- `tests/requests/honesty.test.ts`
- `tests/db/request-capture.db.test.ts`: rollback on audit/event failure; no orphan request; cross-tenant conversation id refused.

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**Started 2026-10-25** after S07-02 merged (`33469c9`). §4 was followed with three changes, each argued in §10:

- `src/requests/honesty.ts` holds the denylist as a module (with reasons per rule) rather than inline in the test, so `tests/requests/honesty.test.ts` scans the catalogue and `replyFor`'s rendered output with the same rules the product is held to.
- The sweep covers **every `guest.*` catalogue string**, not the curated "outbound template" list §4 implied; `staff.*` labels are exempt and why is recorded.
- `guest.request_failed` was **not** added — see §10.

Still owed to someone else: copy review by the content owner (W00-10) before G1 sign-off. The honesty test constrains claims, not tone.
## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview`, `web-build`, `eval`.
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs S07-03 "✅ Done (…)"`.
- [x] Cross-tenant isolation suite extended (no new table; `tests/db/request-capture.db.test.ts` proves a foreign conversation id is refused and writes nothing).
- [x] Review threads resolved; charter §9 decisions recorded in the runbook.

## 10. Outcome (2026-10-25)

**AC-1 met.** `captureRequest` (`src/requests/capture.ts`) writes `service_requests` — and, for a no-answer, the `knowledge_gaps` row — **before** the acknowledgement message and inside the guest turn's transaction. If anything after capture fails, the request, the gap and the events roll back with the message; the test throws after capturing and asserts an empty result. One open request per conversation: a second unanswered question joins it, a second identical question reuses the gap. The end-to-end cases go through `postGuestMessage`: a refund question produces a `needs_human` request and a `guest.request_ack`; `xyzzyqqq` produces an `unanswered_question` request with exactly one gap, reusing the one the pipeline wrote.

**AC-2 met.** `src/requests/honesty.ts` (five rules: confirmed, booked, en route, done, guaranteed, ES+EN) is applied to every `guest.*` string in both languages and to every branch of `replyFor` rendered in both languages. The suite first proves the rules are not vacuous — nine sample sentences that must be caught — then asserts zero offenders, and asserts it scanned at least twenty strings so an empty sweep cannot pass.

**A real bug, not just a test.** The copy already promised a human on both the no-answer and outage paths while no request row existed. Capture closes that; the escalate path's copy changed from "I don't want to guess" to `guest.request_ack` because a refund question is not a knowledge gap, it is a human's job.

**Deliberately not done:** `guest.request_failed` (a failed capture rolls the turn back, so the string would describe an unreachable state); the lifecycle transitions (S09-01) and email delivery (S09-05), both out of scope by §3.
