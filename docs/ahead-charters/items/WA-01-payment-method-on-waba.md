---
id: WA-01
title: Payment method on WABA
sprint: WA
epic: WhatsApp track (W14-W16)
track: Founder
estimate_days: 0.25
priority: P1
depends_on: [W00-08]
labels: [sprint:WA, track:foundation, prio:P1]
milestone: WhatsApp track (W14-W16)
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/109
pickup: external
---

# WA-01 — Payment method on WABA

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | WA |
| Track / days / priority | Founder · 0.25d · P1 |
| Depends on | W00-08 |
| Pickup | `external` |

## 1. Why / goal

Billing active; spend alert configured.

## 2. Acceptance criteria (backlog AC verbatim)

> Billing active; spend alert configured.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Record the WABA billing account, card, monthly cap and alert threshold in `docs/decisions/WHATSAPP-BSP.md`.
- Add a calendar reminder for monthly spend review (G5 evidence).

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- External/Meta approval; start in W0 because it is calendar time (backlog §WhatsApp track).

## 9. Definition of done

- [ ] Billing active screenshot filed.
- [ ] Workbook ticked.
