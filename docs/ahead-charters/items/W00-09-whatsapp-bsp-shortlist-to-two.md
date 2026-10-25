---
id: W00-09
title: WhatsApp BSP shortlist to two
sprint: W00
epic: W00 - Foundation lock
track: Founder
estimate_days: 0.25
priority: P1
depends_on: [W00-08]
labels: [sprint:W00, track:foundation, prio:P1]
milestone: W00 - Foundation lock
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/55
pickup: external
---

# W00-09 — WhatsApp BSP shortlist to two

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | W00 |
| Track / days / priority | Founder · 0.25d · P1 |
| Depends on | W00-08 |
| Pickup | `external` |

## 1. Why / goal

Choose the provider path (direct Cloud API vs BSP with Embedded Signup) — D11, hard to reverse.

## 2. Acceptance criteria (backlog AC verbatim)

> Two providers shortlisted with number-portability and Embedded Signup answers.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Create `docs/decisions/WHATSAPP-BSP.md` comparing two options on Embedded Signup, number portability, pricing, webhook signature scheme and template approval SLA.
- Record the ruling in the ADR log (D11) — WA-02/03/06 charters depend on the signature scheme and template names.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- DEC-5 in `README.md`. Blocks WA-02, WA-03, WA-06, WA-07.

## 9. Definition of done

- [ ] Objective evidence attached (document, screenshot, email or CI log).
- [ ] Workbook ticked with `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"`.
- [ ] G0 review (W00-20) records the decision and the signer.
