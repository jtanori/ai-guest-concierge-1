---
id: WA-07
title: Number-migration safeguards
sprint: WA
epic: WhatsApp track (W14-W16)
track: Founder
estimate_days: 0.5
priority: P1
depends_on: [W00-04]
labels: [sprint:WA, track:foundation, prio:P1]
milestone: WhatsApp track (W14-W16)
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/115
pickup: external
---

# WA-07 — Number-migration safeguards

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | WA |
| Track / days / priority | Founder · 0.5d · P1 |
| Depends on | W00-04 |
| Pickup | `external` |

## 1. Why / goal

Do not lose the hotel's existing WhatsApp number when moving to the API.

## 2. Acceptance criteria (backlog AC verbatim)

> Migration plan with rollback; number ownership stays with the hotel.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Create `docs/decisions/WA-NUMBER-MIGRATION.md`: current number, owner (hotel, D11), porting steps, the old-number shutdown date, rollback (revert to the consumer app), and a verification call/SMS.
- Record the business-account id and phone-number id in the runbook's environment section (ids only, never tokens).

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- External/provider-dependent (DEC-5). Calendar time — start W5.

## 9. Definition of done

- [ ] Plan signed by the hotel.
- [ ] Rollback tested or explicitly waived.
- [ ] Workbook ticked.
