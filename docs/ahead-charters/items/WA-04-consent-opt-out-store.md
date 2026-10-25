---
id: WA-04
title: Consent + opt-out store
sprint: WA
epic: WhatsApp track (W14-W16)
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [WA-03]
labels: [sprint:WA, track:foundation, prio:P0]
milestone: WhatsApp track (W14-W16)
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/112
pickup: decision
---

# WA-04 — Consent + opt-out store

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | WA |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | WA-03 |
| Pickup | `decision` |

## 1. Why / goal

Honour opt-out immediately and keep consent attributable.

## 2. Acceptance criteria (backlog AC verbatim)

> Opt-out stops all outbound messages immediately; consent is recorded.



## 3. Scope

**In:** Consent table, opt-out keywords, send-time check, audit.

**Out:** Legal notice text (W00-18); template approval (WA-06).

## 4. Calculated changes (for the coding agent)

- Migration `0026_wa_consent.sql`: `wa_consents(org_id, property_id, identity_id, consented_at, source, withdrawn_at, UNIQUE (property_id, identity_id))` + FORCE RLS + policy; add a CHECK that `withdrawn_at IS NULL OR withdrawn_at >= consented_at`.
- `src/wa/consent.ts`: `recordConsent`, `withdrawConsent` (keywords `STOP`, `BAJA`, `ALTO`, `UNSUBSCRIBE` in ES/EN parsed from inbound text before any AI call), `assertSendable(client, context, identityId)` called by `sendWhatsAppMessage` — a withdrawn identity must make the worker mark the outbox row `dead` with `reason='opted_out'` rather than retrying.
- Emit an audit row `wa.consent_withdrawn` (add to `src/audit/actions.ts`) and log a `message_failed` event on a suppressed send.

## 5. Tenancy & security

Consent is per `(property_id, identity_id)`; a guest who opts out of property A must still be reachable by property B if they consented there.

## 6. Test plan (named cases)

- `tests/db/wa-consent.db.test.ts`: opt-out keyword → `withdrawn_at` set; send refused; cross-property isolation; re-consent flow.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- `G5 consent test transcript`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-5 / W00-18** — exact opt-out keywords and the consent record's legal wording need provider + counsel sign-off; the schema and enforcement path are calculated.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
