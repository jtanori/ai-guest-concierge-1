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
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/93
pickup: done
---

# S09-05 — Email notifications

> **Approved to start by the user on 2026-10-26** as the last item of the S09-01…S09-05 sequence. The draft notice is retained for provenance: this file was generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`, and `docs/charters/README.md` says "No item starts until its charter is approved". §4 was rebased on the merged baseline and every deviation is recorded in §8 and in the runbook.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S09-01 |
| Pickup | `done` |

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

**DONE — user approved the S09 sequence on 2026-10-26, and DEC-4 closed the same day.** Delivery evidence is the one thing still outstanding; see §9 and the runbook.

**DEC-4 (email provider + credentials) — CLOSED by the operator on 2026-10-26:**

- **Provider: Resend**, over plain `fetch`. No SDK, so the standing "no new runtime dependency without explicit approval" rule is untouched and `qrcode` remains the only sanctioned addition. A transactional-email API is one POST with a bearer token; an SDK would be a supply-chain surface for forty lines.
- **Credentials come later.** The operator supplies `EMAIL_API_KEY` when staging is configured, so **no real email has been sent and none was attempted**. Everything up to the send is tested; §7's "real delivered email" is recorded as outstanding rather than faked.
- **The fallback address is named by the operator**, and nothing is hardcoded in the repository. `EMAIL_ESCALATION_FALLBACK` is required outside `APP_ENV=local` and refuses boot when absent.

Deviations from §4, all recorded in the runbook:

- **Migration is `0028`, not the number §4 implied.** `0027_answer_review_outbox.sql` is S09-04's and is already on the branch; migration numbers are calculated, never inferred.
- **§4's `enqueueEmail(client, context, {to, subject, body, requestId})` signature was not used, and the difference is a security decision.** §4 puts the composed email *in* the payload. `claim_outbox` is `SECURITY DEFINER` and returns `payload` **before any tenant context exists** — that is the one read a worker cannot do under RLS — so anything in the payload sits on the only cross-tenant surface in this flow, including the guest's own words. The shipped signature is `enqueueEmail(client, {orgId, propertyId, requestId, conversationId, messageId, stage, actorUserId})`: the payload carries ids, and the body is composed at send time from `messages.body` read *after* the tenant GUCs are set. A test pins the payload's exact key set and asserts a distinctive guest phrase appears nowhere in it. This also makes recipients resolve at send time, so a property that adds a contact between the request and a retry reaches that person instead of the fallback.
- **`composeRequestEmail(request, settings)` became `composeRequestEmail(ComposeInput)`.** It is pure and takes already-resolved facts rather than a row plus settings, so composition is testable without a database and the worker owns the reads.
- **The env vars are in `src/notifications/email.ts`, not `src/config/env.ts`.** §4 named `src/config/env.ts`; every later subsystem resolves its own config the same way (`loadGuestConfig`, `loadBotCheckConfig`, `loadLlmConfig`, `loadEmbeddingConfig`), and `AppConfig` is deliberately the four things every entry point needs. `loadEmailConfig` follows the established local-versus-everywhere-else rule from `loadBotCheckConfig`.
- **§4 said "a required `EMAIL_ESCALATION_FALLBACK` env so an empty contact list still reaches someone" — kept, and strengthened.** It is required outside local, has no default, and because it is *deployment-wide rather than tenant-scoped* the mail sent to it omits the guest's message and carries the request id plus a console link. Forwarding one property's guest conversation to an address outside that property's access boundary would be a disclosure. The audit row records `recipientSource: "fallback"` with `redacted: true`, so §6's "fallback used" is evidence rather than a guess.
- **§4's "log `message_failed` on terminal outbox failure" was not used.** `message_failed` is the guest-message taxonomy event and this is not a guest message. Terminal failure writes the audit action `notification.dead` with the reason instead, which is attributable and does not pollute an event type the accuracy metrics read. Three audit actions were added to the closed list: `notification.queued`, `notification.sent`, `notification.dead`.
- **Two notifications, not one per edge.** `new` and `acknowledged` are queued; `assigned`, `resolved` and `cancelled` are not — those are visible in the inbox to anyone looking, and emailing every edge turns the escalation channel into noise, which is how the one notification that mattered gets filtered with the rest. Hence the dedupe key is `request_id:stage`, not `request_id`.
- **0028 generalised S09-04's claim rather than adding a second one.** `claim_review_outbox(integer)` is dropped in favour of `claim_outbox(p_kind text, batch_limit integer)`. A definer function per kind is a cross-tenant *window* per kind, each one another place to get the policy wrong; S11-01's workers inherit one primitive instead of N.
- **`BEGIN` in the worker is load-bearing and §4 did not mention it.** `FOR UPDATE SKIP LOCKED` holds its lock only for the transaction that took it, so without an explicit `BEGIN` the lock is released the instant the claim returns and two workers can claim the same row and both send it. `COMMIT` with no open transaction *succeeds with a warning*, so a single-worker test passes and the bug surfaces in production as duplicate escalation emails.
- **A dead row carries no `next_attempt_at`,** differing deliberately from S09-04's `recordFailure`. `next_attempt_at` means "next eligible for claiming", so a timestamp on a row that will never be claimed again reads as a missed retry. Both email paths set `processed_at`, which is the column that answers "when did we give up". S09-04 stamps a due-time only because it writes no `processed_at`; rewriting that here would be out of scope, so the difference is documented in both places.

**Review round 1 (PR #145) — four findings, all fixed.** Each was a case the tests
could not see rather than a case that failed, so each now has one; details and
reasoning are in the runbook entry.

1. `CONSOLE_BASE_URL` was optional outside local, so production could silently link
   every escalation email to `http://localhost:3000` — which *resolves*, on the
   recipient's own machine. Now required outside `APP_ENV=local`.
2. The provider timeout was cleared when the response **headers** arrived, leaving
   `response.text()` with no deadline. A provider that stalls the body hangs the worker
   while it holds a transaction and a `FOR UPDATE` row lock, pinning a row no other
   worker can claim. The timeout now covers the body read.
3. **The retry path could deliver twice, and a comment in the code claimed it could
   not.** 0028's dedupe index prevents a second outbox *row*; it does nothing about a
   second *delivery* of the row that already exists when Resend accepted the first
   attempt and the response was lost. Fixed with Resend's `Idempotency-Key`, derived
   from the outbox row id so it is stable across retries of one row and distinct
   between rows — a per-attempt key is idempotent against nothing, and a key derived
   from the dedupe key would suppress an operator's deliberate re-queue for Resend's
   whole 24-hour window. The two 409s are handled distinctly:
   `concurrent_idempotent_requests` retries, `invalid_idempotent_request` goes dead
   with reason `conflict_payload` rather than being reported as a send whose content
   cannot be proven.
4. A request whose conversation was deleted (`conversation_id` NULL, per 0001) still
   printed a console link ending in `/inbox/`, despite a worker comment saying it was
   omitted. The conversation line is now its own catalogue block with a
   `no_conversation` variant and the link block is dropped.

**Scope caveat, agreed with the reviewer.** Nothing schedules `processEmailOutbox`, so
as merged this item *queues* notifications and does not *deliver* them. The
end-to-end reading of AC-1 — "a request reaches a human by email" — is **not
operational** until S11-01 deploys and schedules the worker. What is met here is the
part this item owns: the row is written atomically with the request, survives provider
failure, resolves recipients from the right tenant's settings, and is composed and
handed to a provider correctly. This is recorded in §9 and in the runbook rather than
left to be discovered by someone waiting for an email that was queued and never sent.

## 9. Definition of done

- [x] Implemented and measured locally, after review round 1: `db:migrate` **28** from empty, `db:test` **38 files / 400** (email outbox 32), `npm test` **47 files / 620** (email pure 44), root+web `tsc` clean, `lint` clean, `web:build` green. Runbook entry `## S09-05 - Email notifications (0.50d)`.
- [x] §6's named cases all exist and pass. `tests/notifications/email.test.ts` (34): empty contacts → fallback used; ES/EN bodies; **no PII beyond the request id in the subject**; plus config refusal, `in_app` contacts not counting as addresses, dedupe, the redacted fallback body, no empty quote block for a button-tap request, backoff, and the Resend call shape against an injected `fetch`. `tests/db/email-outbox.db.test.ts` (27): request + outbox row atomic **in both directions** (commit visible to a session that was not part of the turn; rollback takes the notification with it); provider failure leaves the row with `attempts` incremented and a future due-time; not-due rows are not claimed; retry succeeds; permanent refusal goes `dead` on the first attempt; retries exhaust to `dead` + audit; nobody-to-send-to is loud; **§5's cross-tenant assertion** — each property answered from its own settings, and a payload naming tenant A's request cannot be redirected by tenant B's settings.
  - One deviation from §6's wording: it says a failure "leaves `status='pending'` with `attempts` incremented". The shipped behaviour leaves `status='failed'`, because `claim_outbox` selects `status IN ('pending','failed')` and a retried row that stayed `pending` would be indistinguishable from one never attempted. `attempts` is incremented as specified, and `last_error` carries the reason.
- [x] Cross-tenant isolation: no new table (the `outbox` has existed since 0001 and is already in the isolation suite), but the new **definer function** is covered — `tests/db/non-superuser.db.test.ts` runs the whole 28-file chain as a non-superuser owner, and `tests/db/email-outbox.db.test.ts` asserts `claim_outbox`'s owner, `prosecdef`, an ACL with **no PUBLIC entry**, `concierge_worker` NOLOGIN, and `pg_has_role('concierge_app','concierge_worker','MEMBER')` false. **No new runtime dependency.**
- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] **AC-1 is not operational until S11-01 schedules the worker.** Merged state
      queues notifications correctly; nothing sends them. Do not describe the
      end-to-end criterion as met before the worker is deployed.
- [ ] **§7's third evidence item is OUTSTANDING: `staging inbox screenshot of a real delivered email`.** DEC-4 deferred credentials, so nothing was sent. To close it: set `EMAIL_FROM`, `EMAIL_API_KEY`, `EMAIL_ESCALATION_FALLBACK` and `CONSOLE_BASE_URL` in a staging `.env`, verify the sender domain in Resend, open a request as a guest, and keep the received email plus the `notification.sent` audit row with its `providerId`. Joins the other outstanding physical-evidence items (S07-01 QR scan, S08-01 stopwatch, S08-02 sources screenshot, S06-01 staging).
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
