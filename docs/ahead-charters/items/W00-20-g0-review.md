---
id: W00-20
title: G0 review
sprint: W00
epic: W00 - Foundation lock
track: Both
estimate_days: 0.25
priority: P1
depends_on: [W00-03, W00-08, W00-10]
labels: [sprint:W00, track:foundation, prio:P1]
milestone: W00 - Foundation lock
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/66
pickup: external
---

# W00-20 — G0 review

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | W00 |
| Track / days / priority | Both · 0.25d · P1 |
| Depends on | W00-03, W00-08, W00-10 |
| Pickup | `external` |

## 1. Why / goal

The gate that formally allows S01+ work and records anything still open.

## 2. Acceptance criteria (backlog AC verbatim)

> 14 ADRs signed · verification submitted · content owner named · fixture seeded.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Create `docs/decisions/G0-REVIEW.md` with a checkbox per gate criterion, signer, date, and an explicit list of waived items with owners and due dates.
- Tick `W00-20` and record the gate status in `docs/runbook.md`.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- G0 is a hard gate ('Do not start S01'). Since S01–S03 already shipped, record a retrospective G0 with the waivers rather than pretending it was green.

## 9. Definition of done

- [ ] Objective evidence attached (document, screenshot, email or CI log).
- [ ] Workbook ticked with `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"`.
- [ ] G0 review (W00-20) records the decision and the signer.
