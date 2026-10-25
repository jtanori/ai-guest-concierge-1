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
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/81
pickup: ready
---

# S07-03 — Request capture + honest acknowledgement

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

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

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — no external decision. Copy must be reviewed by the content owner (W00-10) before G1 sign-off.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
