---
id: WA-02
title: Adapter: webhook ingress
sprint: WA
epic: WhatsApp track (W14-W16)
track: Eng
estimate_days: 1.5
priority: P0
depends_on: [W00-09, S11-02]
labels: [sprint:WA, track:foundation, prio:P0]
milestone: WhatsApp track (W14-W16)
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/110
pickup: decision
---

# WA-02 — Adapter: webhook ingress

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | WA |
| Track / days / priority | Eng · 1.5d · P0 |
| Depends on | W00-09, S11-02 |
| Pickup | `decision` |

## 1. Why / goal

Signed, deduplicated inbound WhatsApp messages that ack in <3s.

## 2. Acceptance criteria (backlog AC verbatim)

> Signed, deduplicated inbound messages; ack under 3s; process async.



## 3. Scope

**In:** WhatsApp webhook route, signature verification, dedupe, async enqueue.

**Out:** Send path (WA-03); consent (WA-04); templates (WA-06).

## 4. Calculated changes (for the coding agent)

- `api/wa/webhook.ts` (Vercel handler, same `IncomingMessage/ServerResponse` shape as `api/health.ts`): `GET` verifies the hub challenge token; `POST` verifies `X-Hub-Signature-256` with `crypto.timingSafeEqual` over the **raw** body, then calls `src/webhooks/ingress.ts::acceptInbound` (S11-02) with `provider='whatsapp'` and the provider message id.
- `src/wa/parse.ts`: normalise the Cloud API payload into `{connectionId, externalId, text, language, timestamp, providerMessageId}`; reject unsupported message types with a 200 ack + a `knowledge_gaps`-style log (never a 500 that triggers endless retries).
- Ack `200` as soon as the `outbox` row is committed; all processing happens in S11-01's worker. Add `WA_APP_SECRET`, `WA_VERIFY_TOKEN` to `src/config/env.ts`.
- Register `channel_connections(channel='whatsapp')` + `channel_identities` per phone number; conversation resolution reuses `src/conversation/service.ts`.

## 5. Tenancy & security

Tenant comes from the phone-number → `channel_connections` mapping, never from the webhook body's `to` field alone; verify the mapping is unique per property.

## 6. Test plan (named cases)

- `tests/wa/webhook.test.ts`: valid signature, tampered body, 10× replay → 1 message, ack time <3s with a slow worker, unsupported type → 200 + no crash.

## 7. Evidence to record in the runbook

- ``npm test``
- `Meta webhook delivery log + ack timings in runbook`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-5 (BSP/provider, W00-09):** the signature scheme and payload shape depend on the chosen provider. The ingress/dedupe contract is calculated; the parser waits on the decision. Also blocked by W00-08 (Meta verification).

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
