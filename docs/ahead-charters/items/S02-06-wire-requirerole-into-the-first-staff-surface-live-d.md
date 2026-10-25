---
id: S02-06
title: Wire requireRole into the first staff surface + live denial test
sprint: S02
epic: S02 - Identity, settings, audit
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S04-01]
labels: [sprint:S02, track:foundation, prio:P0]
milestone: S02 - Identity, settings, audit
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/14
pickup: blocked
---

# S02-06 — Wire requireRole into the first staff surface + live denial test

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S02 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S04-01 |
| Pickup | `blocked` |

## 1. Why / goal

S02-01 shipped PARTIAL: `withStaffSession` / `requireRole` / the surface matrix exist, but no production caller proves the verbatim AC.

## 2. Acceptance criteria (backlog AC verbatim)

> Each role can only reach its own surface.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (deferred to S04-01 — see below)

- **No independent PR.** This AC is discharged inside S04-01, the first staff route: `POST /api/review/approve` must call `session.requireRole("knowledge", "write")` from `withStaffSession` (`src/auth/context.ts`) before any write.
- Add `tests/db/role-denial.db.test.ts`: owner/manager allowed; `front_desk`/`observer` denied by `RoleNotOnSurfaceError`; and the denied call performs **zero writes** (count `article_reviews`, `property_facts`, `audit_log` before/after).
- Upgrade `docs/runbook.md` S02-01 from PARTIAL to DONE and tick `S02-01` only after the denial test passes in CI.
- Backlog v2 has no `S02-06` row — add one to `docs/07-master-backlog.md`/xlsx (or record it as a waiver) so the estimate (1.0d) is visible in the 69.75-day total.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- `tests/db/role-denial.db.test.ts` (allow + deny + no-write).
- `tests/auth/guard.test.ts` already covers the pure matrix.

## 7. Evidence to record in the runbook

- ``npm run db:test` (denial case)`
- ``npm test``

## 8. Pickup status, blockers and decisions

**BLOCKED — depends on in-flight work (PR #32 / S04-01). Calculations deferred; contract stated instead.**

Open decisions / blockers:

- Blocked by S04-01 (and by DEC-1, the UI framework). Tracked on GitHub issue #14 — close that issue when this lands.

## 9. Definition of done

- [ ] AC-1/2/3 of issue #14 pass in CI.
- [ ] Runbook S02-01 DONE.
- [ ] Workbook `S02-01` + the new row ticked.
- [ ] Issue #14 closed.
