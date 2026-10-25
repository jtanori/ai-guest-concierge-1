---
id: WA-03
title: Adapter: send path + 24h window
sprint: WA
epic: WhatsApp track (W14-W16)
track: Eng
estimate_days: 1.5
priority: P0
depends_on: [WA-02, S11-01]
labels: [sprint:WA, track:foundation, prio:P0]
milestone: WhatsApp track (W14-W16)
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/111
pickup: decision
---

# WA-03 — Adapter: send path + 24h window

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | WA |
| Track / days / priority | Eng · 1.5d · P0 |
| Depends on | WA-02, S11-01 |
| Pickup | `decision` |

## 1. Why / goal

Send replies and respect Meta's 24-hour customer-service window.

## 2. Acceptance criteria (backlog AC verbatim)

> Outbound replies delivered; outside 24h a template is used.



## 3. Scope

**In:** Send adapter, 24h window logic, template fallback, delivery events.

**Out:** Template authoring/approval (WA-06); consent (WA-04).

## 4. Calculated changes (for the coding agent)

- `src/wa/send.ts`: `sendWhatsAppMessage(client, context, {to, body, template?})` — if `now() - lastInboundAt <= 24h` send a session message; else require an approved template name from `WA_TEMPLATES` (WA-06) and send with parameters.
- Register an `OutboxSender` handler for `kind='provider_message'` with `channel='whatsapp'` in `src/outbox/worker.ts` (S11-01); write `message_delivery_events(stage, provider_message_id, occurred_at)` on queued/sent/failed.
- `src/wa/client.ts`: `fetch` to the Cloud API `/messages` endpoint with `WA_PHONE_NUMBER_ID` + `WA_ACCESS_TOKEN`; parse the provider error codes (131047 = outside window, 131026 = undeliverable) into typed errors so the worker can choose template vs `dead`.
- Add `"wa:send"` smoke script for staging.

## 5. Tenancy & security

Recipient numbers are `channel_identities.external_id` scoped to `(org_id, property_id)`; never send to a number from another tenant.

## 6. Test plan (named cases)

- `tests/wa/send.test.ts`: inside/outside 24h, template fallback, provider 131047 → template, 5xx → retry, delivery event rows.

## 7. Evidence to record in the runbook

- ``npm test``
- `staging send + delivery transcript in runbook`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-5** — endpoint/credentials/template ids depend on the BSP decision. Window logic and outbox integration are calculated.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
