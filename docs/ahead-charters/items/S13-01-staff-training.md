---
id: S13-01
title: Staff training
sprint: S13
epic: S13 - Launch
track: Founder
estimate_days: 1.0
priority: P1
depends_on: [S12-04]
labels: [sprint:S13, track:foundation, prio:P1]
milestone: S13 - Launch
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/106
pickup: external
---

# S13-01 — Staff training

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S13 |
| Track / days / priority | Founder · 1.0d · P1 |
| Depends on | S12-04 |
| Pickup | `external` |

## 1. Why / goal

Train the pilot property's staff before guests see the product.

## 2. Acceptance criteria (backlog AC verbatim)

> Each staff member completes a live test conversation.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Create `docs/pilot/TRAINING.md`: 30-minute curriculum (AI disclosure, when to take over, how to flag a wrong answer, request lifecycle, ES/EN catalogue), a checklist per staff member and a sign-off table.
- Each staff member runs one live test conversation on staging; record conversation ids (not message bodies) as evidence.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- Non-code. Depends on S12-04 and the pilot property's calendar (W00-10).

## 9. Definition of done

- [ ] Sign-off table complete.
- [ ] Workbook ticked.
