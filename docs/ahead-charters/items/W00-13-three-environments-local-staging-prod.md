---
id: W00-13
title: Three environments: local, staging, prod
sprint: W00
epic: W00 - Foundation lock
track: Eng
estimate_days: 0.75
priority: P0
depends_on: [W00-12]
labels: [sprint:W00, track:foundation, prio:P0]
milestone: W00 - Foundation lock
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/59
pickup: ready
---

# W00-13 — Three environments: local, staging, prod

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | W00 |
| Track / days / priority | Eng · 0.75d · P0 |
| Depends on | W00-12 |
| Pickup | `ready` |

## 1. Why / goal

Close out the environment gate that already has runbook evidence but no workbook tick.

## 2. Acceptance criteria (backlog AC verbatim)

> Three separate databases; no shared DB; CI proves staging and prod differ.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (for the coding agent)

- `src/config/env.ts::resolveDeploymentEnvironments` and `scripts/check-env.ts` already implement the gate — no new module needed.
- Add `npm run check:env` to the CI `lint` job (or a new `env-check` step) so a misconfigured deployment fails the build.
- Extend `tests/config/env.test.ts` with the three-URL matrix (staging ≠ prod ≠ local).
- Close the `W00-13` runbook entry (`docs/runbook.md:108`) with the CI log and tick the workbook.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- ``npm run check:env``
- ``npm test` (env matrix)`

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- Evidence exists in the runbook; this is a close-out/hygiene item, not new engineering.

## 9. Definition of done

- [ ] CI `check:env` step green.
- [ ] Runbook `W00-13` entry upgraded from evidence to DONE.
- [ ] Workbook ticked.
