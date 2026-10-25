---
id: S11-02
title: Idempotency + webhook dedupe
sprint: S11
epic: S11 - Reliability
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S06-01]
labels: [sprint:S11, track:foundation, prio:P0]
milestone: S11 - Reliability
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/98
pickup: ready
---

# S11-02 — Idempotency + webhook dedupe

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S11 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S06-01 |
| Pickup | `ready` |

## 1. Why / goal

Replaying a webhook 10× produces one message (D8).

## 2. Acceptance criteria (backlog AC verbatim)

> Replaying a webhook 10x produces one message.

- **AC-1** `provider_message_id` is unique per property; duplicates return the original message id.
- **AC-2** Ack <3s; processing is async via the outbox.

## 3. Scope

**In:** Dedupe table, ingress handler, idempotent send.

**Out:** WhatsApp-specific signature verification (WA-02).

## 4. Calculated changes (for the coding agent)

- Migration `0024_webhook_dedupe.sql`: `webhook_dedupe(org_id, property_id, provider text, provider_message_id text, received_at timestamptz DEFAULT now(), message_id uuid, PRIMARY KEY (property_id, provider, provider_message_id))` + composite FK to `messages` + FORCE RLS + policy; also `CREATE UNIQUE INDEX message_delivery_events_provider ON message_delivery_events (property_id, provider_message_id) WHERE provider_message_id IS NOT NULL`.
- `src/webhooks/ingress.ts`: `acceptInbound(client, context, {provider, providerMessageId, payload})` — verify signature **first**, `INSERT ... ON CONFLICT DO NOTHING RETURNING message_id`; if no row returned, return `{duplicate: true, messageId: existing}` and enqueue nothing. Ack within 3s; push the payload to `outbox` and let S11-01 process it.
- `src/webhooks/signature.ts`: HMAC-SHA256 over the raw body with a timing-safe compare (`crypto.timingSafeEqual`); secret from `src/config/env.ts`; reject >5-minute skew to stop replays.
- Add `tests/webhooks/ingress.test.ts` for 10× replay + a tampered signature.

## 5. Tenancy & security

Dedupe key includes `property_id`; a foreign provider id must not collide with another tenant's.

## 6. Test plan (named cases)

- `tests/db/webhook-dedupe.db.test.ts`: 10 identical deliveries → 1 message + 1 outbox row; concurrent inserts race-safe (23505 handled); tampered signature rejected before any write.
- `tests/webhooks/signature.test.ts`: timing-safe, skew window.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- ``npm test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — depends on S06-01 for the `messages` rows. WA-02 reuses this ingress.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
