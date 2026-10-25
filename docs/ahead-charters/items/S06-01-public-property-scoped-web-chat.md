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
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/76
pickup: decision
---

# S06-01 — Public property-scoped web chat

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

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

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-1 (UI framework)** — default zero-dependency server-rendered HTML; a framework needs dependency approval. Route/service calculations are complete.
- Depends on S05-01 (and transitively DEC-2). Start the service layer before the framework decision closes.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
