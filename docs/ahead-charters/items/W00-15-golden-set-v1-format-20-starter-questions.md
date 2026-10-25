---
id: W00-15
title: Golden set v1: format + 20 starter questions
sprint: W00
epic: W00 - Foundation lock
track: Founder
estimate_days: 0.5
priority: P1
depends_on: []
labels: [sprint:W00, track:foundation, prio:P1]
milestone: W00 - Foundation lock
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/61
pickup: external
---

# W00-15 — Golden set v1: format + 20 starter questions

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | W00 |
| Track / days / priority | Founder · 0.5d · P1 |
| Depends on | — |
| Pickup | `external` |

## 1. Why / goal

Freeze the golden-question format; v2 (≥40 questions from the hotel) is a G1 input.

## 2. Acceptance criteria (backlog AC verbatim)

> Format agreed, 20 starter questions validated.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- `data/golden/golden-questions-v1.csv` (20 rows: 13 answer / 7 escalate) and `src/golden/validate.ts` + `src/golden/validate.test.ts` already exist and pass.
- Close the workbook status `🚧 Local evidence verified — pending founder sign-off that the format is agreed` by recording signer + date in `docs/runbook.md:158`.
- Create `data/golden/golden-questions-v2-TEMPLATE.csv` with the same 6 columns and the 40-question target split (~2/3 answer, ~1/3 escalation) per plan §4.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- Founder sign-off only. v2 content is hotel-supplied (G1) and blocks S04-03's recall proof and S06-03's harness.

## 9. Definition of done

- [ ] Objective evidence attached (document, screenshot, email or CI log).
- [ ] Workbook ticked with `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"`.
- [ ] G0 review (W00-20) records the decision and the signer.
