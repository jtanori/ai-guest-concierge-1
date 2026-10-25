---
id: S13-02
title: Content corrections from the dry run
sprint: S13
epic: S13 - Launch
track: Both
estimate_days: 0.5
priority: P1
depends_on: [S12-04]
labels: [sprint:S13, track:foundation, prio:P1]
milestone: S13 - Launch
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/107
pickup: external
---

# S13-02 — Content corrections from the dry run

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S13 |
| Track / days / priority | Both · 0.5d · P1 |
| Depends on | S12-04 |
| Pickup | `external` |

## 1. Why / goal

No known-wrong article in the published set.

## 2. Acceptance criteria (backlog AC verbatim)

> No known-wrong article in the published set.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (content ops, one code path reused)

- Use the S03-02 `importArticleCsv` preview → commit flow (`src/knowledge/csv.ts`, `src/knowledge/import.ts`) to apply corrections; re-run `npm run eval` and `listContradictions` afterwards.
- Create `docs/pilot/CONTENT-FIXES.md` mapping each dry-run defect to an article version id, the change and the new golden question (if any).
- Re-verify the affected facts with `verifyFact` (PR #32) and re-embed with `chunkAndPublish` (S04-02); assert `npm run reconcile` is clean.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- Mostly content ops. Reuses S03-02/S03-03/S04-02 code paths — no new module. Depends on S12-04's defect log.

## 9. Definition of done

- [ ] Defect log empty or waived in writing.
- [ ] `npm run eval` green after corrections.
- [ ] Workbook ticked.
