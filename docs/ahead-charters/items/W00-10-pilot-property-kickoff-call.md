---
id: W00-10
title: Pilot property kickoff call
sprint: W00
epic: W00 - Foundation lock
track: Founder
estimate_days: 0.5
priority: P1
depends_on: []
labels: [sprint:W00, track:foundation, prio:P1]
milestone: W00 - Foundation lock
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/56
pickup: external
---

# W00-10 — Pilot property kickoff call

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | W00 |
| Track / days / priority | Founder · 0.5d · P1 |
| Depends on | — |
| Pickup | `external` |

## 1. Why / goal

Name a content owner with 4–6 hours on the calendar; content is the #1 critical path item.

## 2. Acceptance criteria (backlog AC verbatim)

> Named content owner, dated calendar slots, content handover format agreed.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Create `docs/pilot/PROPERTY.md` with owner name, contact, language pair, time zone, and the 25-article / 40-fact / 40-question handover checklist from plan §4.
- Attach the `data/golden/golden-questions-v1.csv` format and the CSV import template from S03-02 (`src/knowledge/csv.ts`).

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- Blocks W00-16, G1 and the S04-03 recall exit. This is the single highest-leverage non-code item.

## 9. Definition of done

- [ ] Objective evidence attached (document, screenshot, email or CI log).
- [ ] Workbook ticked with `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"`.
- [ ] G0 review (W00-20) records the decision and the signer.
