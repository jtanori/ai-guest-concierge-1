---
id: S09-05
title: Email notifications
sprint: S09
epic: S09 - Requests and notifications
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S09-01]
labels: [sprint:S09, track:foundation, prio:P0]
milestone: S09 - Requests and notifications
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/93
pickup: decision
---

# S09-05 — Email notifications

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S09-01 |
| Pickup | `decision` |

## 1. Why / goal

A request nobody sees is not a request — email must reach a human even with no staff view.

## 2. Acceptance criteria (backlog AC verbatim)

> A request with no staff view still reaches a human by email.

- **AC-1** Every new/acknowledged request enqueues an email to `escalation.contacts` from `PropertySettings`.
- **AC-2** Provider failure retries via the outbox and never loses the notification.

## 3. Scope

**In:** Email composer, enqueue, provider adapter, escalation contact fallback.

**Out:** SMS/push; the outbox worker (S11-01).

## 4. Calculated changes (for the coding agent)

- `src/notifications/email.ts`: `composeRequestEmail(request, settings)` — subject + body from `src/i18n/catalog.ts` (add `email.request.*` in ES+EN); recipients from `settings.escalation.contacts` (`src/settings/schema.ts`), with a required `EMAIL_ESCALATION_FALLBACK` env so an empty contact list still reaches someone.
- `enqueueEmail(client, context, {to, subject, body, requestId})` → `INSERT INTO outbox (kind='email', payload, status='pending')` in the request transaction (D7).
- `src/providers/email.ts`: `sendEmail(payload)` via `fetch` to the chosen provider API; no SDK dependency unless approved. Env `EMAIL_API_KEY`, `EMAIL_FROM` in `src/config/env.ts`.
- Emit `request_created` (already S09-01) and log `message_failed` on terminal outbox failure; add a `notifications` audit action.

## 5. Tenancy & security

Recipients come from property settings, never from the guest payload; assert a cross-tenant settings read cannot redirect email.

## 6. Test plan (named cases)

- `tests/notifications/email.test.ts`: empty contacts → fallback used; ES/EN bodies; no PII beyond the request id in the subject.
- `tests/db/email-outbox.db.test.ts`: request + outbox row are atomic; provider failure leaves `status='pending'` with `attempts` incremented.

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``
- `staging inbox screenshot of a real delivered email`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-4 (email provider + credentials).** Composer, enqueue and tests are calculated; the adapter + env vars wait on the provider choice and dependency approval (same class as DEC-2/3).

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
