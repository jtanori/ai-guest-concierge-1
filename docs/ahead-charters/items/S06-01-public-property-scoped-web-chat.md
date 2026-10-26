---
id: S06-01
title: Public property-scoped web chat
sprint: S06
epic: S06 - Guest chat and evaluation
track: Eng
estimate_days: 2.0
priority: P0
depends_on: [S05-01]
labels: [sprint:S06, track:foundation, prio:P0]
milestone: S06 - Guest chat and evaluation
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/76
pickup: ready
approved: 2026-10-25
done: 2026-10-25
---

# S06-01 — Public property-scoped web chat

| | |
|---|---|
| Sprint | S06 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S05-01 |
| Pickup | `decision` |

## 1. Why / goal

A stranger can hold a full conversation on staging — the pilot surface.

## 2. Acceptance criteria (backlog AC verbatim)

> A stranger holds a full conversation on staging.

- **AC-1** `GET /c/:propertySlug` serves a working chat; `POST /api/chat/messages` persists inbound + outbound `messages`.
- **AC-2** Tenant comes from the URL slug only — never from a request body.
- **AC-3** First message shows `guest.ai_disclosure` and a route to a human (S07-02).

## 3. Scope

**In:** Guest route, anonymous identity, conversation/message persistence, AI message orchestration.

**Out:** WhatsApp adapter (WA track); staff inbox (S08); framework choice (DEC-1).

## 4. Calculated changes (for the coding agent)

- `src/http/guest.ts`: `resolvePublicProperty(client, slug)` — SELECT `org_id, property_id` from `properties WHERE slug=$1` **as a privileged, read-only lookup** (no GUCs yet), then open `withTenant(client, context, ...)`. Never trust `org_id`/`property_id` from the request.
- Routes: `GET /c/:slug` (server-rendered HTML + a small `public/chat.js`, no framework by default), `POST /api/chat/messages` (Vercel `api/chat/messages.ts` wrapper + `src/server.ts` route). Anonymous identity = signed HTTP-only cookie carrying `channel_identities.identity_id`; upsert `(connection_id, external_id)` with a random external id.
- `src/conversation/service.ts`: `postGuestMessage(client, context, {conversationId?, identityId, text, language})` — resolve/create `channel_connections` for channel `web`, create `conversations` row, `INSERT messages (direction='inbound', author_role='guest')`, call `answerMessage` (S05-01), persist the outbound `messages` row, update `last_activity_at` — all in one transaction.
- Emit `conversation_started` and `message_received` via `createEvent` (`src/events/taxonomy.ts`); the event writer lands in S10-01, so keep a narrow `emitEvent` port.
- Add `guest.chat.*` strings to `src/i18n/catalog.ts` (both languages — typecheck enforces parity).

## 5. Tenancy & security

**Highest-risk tenancy path in the product.** Guest routes must not share the staff `withStaffSession`; they set `app.current_org_id`/`current_property_id` from the slug-derived context under `SET LOCAL ROLE concierge_app`. Add a DB test that a forged `property_id` in the body cannot redirect a write.

## 6. Test plan (named cases)

- `tests/db/guest-chat.db.test.ts`: full conversation on a scratch DB; foreign slug 404; forged tenant body ignored; disclosure present on first message.
- `tests/http/guest.test.ts`: route parsing, cookie signing, 400 on empty message.
- Staging smoke: `curl -X POST https://<preview>/api/chat/messages` (evidence in runbook).

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``
- `staging preview URL + curl transcript`

## 8. Pickup status, blockers and decisions

**CLOSED.** Both blockers named here resolved before pickup:

- **DEC-1 (UI framework) — closed as React 19 + Next.js 15 + Tailwind + shadcn/ui**, the stack S04-01 already shipped in `web/`. This charter's "no framework by default" line was written before DEC-1 closed; the file was overruled by the decision, and the guest page is a Next.js route (`web/app/c/[slug]/page.tsx`) rather than server-rendered HTML plus a hand-written `public/chat.js`. Everything else in §4 held: the slug lookup is a privileged read-only resolution, the service persists both messages in one transaction, and the tenant never comes from the body.
- **S05-01 / DEC-2 (provider)** — closed: Google Gemini over plain `fetch` (pinned primary + fallback), consumed through `AnswerDeps.ai`.

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview`, `web-build`.
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs` — **`🚧`, not `✅`**: the "on staging" half of AC-1 is unverified (see §10).
- [x] Cross-tenant isolation suite extended for the new route; no new runtime dependency (Next.js was already approved under DEC-1).
- [x] Review threads resolved; §8 decisions recorded in the runbook.

## 10. Outcome (2026-10-25)

**AC-1, AC-2 and AC-3 met as a working surface; the deployed-staging half of AC-1 is not verified from the build environment.** A real `http.createServer` wrapped around `handleGuestRequest` serves `POST /api/chat/messages` and `GET /api/chat/property`, two turns ride one signed cookie into one conversation, and the transcript replays from the cookie alone. `GET /c/:propertySlug` is a Next.js server component that 404s an unknown slug on the server side.

AC-2 is proven by writing, not reading: a POST carrying a foreign `orgId`/`propertyId`/`conversationId` lands its rows in the slug's property and leaves the other property untouched. The tenant comes from the URL and nowhere else.

AC-3 ships both halves: `guest.ai_disclosure` is rendered above the composer before any answer, and "Talk to a person" posts the catalogue string `guest.talk_to_person`, which S05-02's classifier escalates as `guest_asked_human` — so the handoff is a row in the transcript, not a tooltip.

Evidence: 27 unit files / 374 tests, 22 db files / 195 tests (9 guest-chat + 2 guest-chat-over-HTTP are new), `web:build` green.

**Deliberately not done here:** staging deployment (an operator step), rate limiting / spend enforcement (S07-04 consumes the counters), the S07-02 handoff UI, the staff inbox (S08), and the WhatsApp adapter. Residual risk recorded in the runbook: `concierge_public` inherits PUBLIC `EXECUTE` on SECURITY DEFINER functions because only their owner can revoke it — a dedicated hardening item.
