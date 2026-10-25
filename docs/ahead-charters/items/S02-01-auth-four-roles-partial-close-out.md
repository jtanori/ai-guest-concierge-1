---
id: S02-01
title: Auth + four roles (PARTIAL close-out)
sprint: S02
epic: S02 - Identity, settings, audit
track: Eng
estimate_days: 2.0
priority: P0
depends_on: [S01-01, S04-01]
labels: [sprint:S02, track:foundation, prio:P0]
milestone: S02 - Identity, settings, audit
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/119
pickup: blocked
---

# S02-01 — Auth + four roles (PARTIAL close-out)

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S02 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S01-01, S04-01 |
| Pickup | `blocked` |

## 1. Why / goal

PR #7 merged the primitives (JWKS verification, `provision_user`, `withStaffSession`, `requireRole`, the surface matrix), but the workbook still reads Not started and the verbatim AC is unproven end to end.

## 2. Acceptance criteria (backlog AC verbatim)

> Each role can only reach its own surface.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (skip — implementation exists; AC discharged by S02-06)

- **No new code.** `src/auth/session.ts`, `src/auth/guard.ts`, `src/auth/context.ts` and migrations 0004/0005 are merged and tested (`tests/auth/*`, `tests/db/auth.db.test.ts`).
- The unmet half is tracked by GitHub issue #14 and chartered here as `S02-06`: a production caller of `requireRole` + a DB-backed denial test with no write. It lands inside S04-01, the first staff route.
- Close-out action: after S04-01 merges, upgrade `docs/runbook.md` S02-01 from PARTIAL to DONE, tick `S02-01` in the workbook with the denial-test CI log, and close issue #14.
- Reconcile the workbook: PR #7 was merged but `S02-01` still says *Not started* — this is bookkeeping debt, not missing code.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- `tests/db/role-denial.db.test.ts` (owned by S02-06 / S04-01).

## 7. Evidence to record in the runbook

- ``npm run db:test` (denial case)`
- `CI log from the S04-01 PR`

## 8. Pickup status, blockers and decisions

**BLOCKED — depends on in-flight work (PR #32 / S04-01). Calculations deferred; contract stated instead.**

Open decisions / blockers:

- Blocked by S04-01 / S02-06. Review finding 4369257038 (PR #7 round 2) stays open at the AC level until then.

## 9. Definition of done

- [ ] Issue #14 AC-1/2/3 pass in CI.
- [ ] Runbook S02-01 DONE.
- [ ] Workbook ticked.
- [ ] Issue #14 closed.
