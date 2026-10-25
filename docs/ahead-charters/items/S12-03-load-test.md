---
id: S12-03
title: Load test
sprint: S12
epic: S12 - Pilot readiness
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S08-01]
labels: [sprint:S12, track:foundation, prio:P0]
milestone: S12 - Pilot readiness
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/104
pickup: decision
---

# S12-03 — Load test

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S12 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S08-01 |
| Pickup | `decision` |

## 1. Why / goal

p95 first token ≤3.5s at target load.

## 2. Acceptance criteria (backlog AC verbatim)

> p95 first token <=3.5s at target load.

- **AC-1** At the target concurrent-conversation load, p95 time-to-first-token ≤3.5s.
- **AC-2** The AI provider is stubbed for the load test so the number measures our stack, not an upstream latency.

## 3. Scope

**In:** Load script, target-load definition, p95 measurement, DB index checks.

**Out:** Capacity planning beyond the pilot property.

## 4. Calculated changes (for the coding agent)

- `scripts/load-test.ts`: a dependency-free Node load generator (N concurrent guest conversations, each posting M messages) with an `AI_STUB=1` mode in `src/ai/provider.ts`; measure time from POST to the first response byte, compute p50/p95/p99, print a table and exit 1 above 3.5s p95.
- Define `TARGET_LOAD` from `03-financial-model.xlsx` (pilot property conversations/day) and record it in `docs/runbook.md`.
- `EXPLAIN (ANALYZE, BUFFERS)` the three hot queries (inbox `listInbox`, hybrid retrieval, `lookupFact`) and attach plans; add any missing index from S04-03/S08-01 rather than tuning the app blindly.
- Add a `load-test.yml` workflow that runs nightly against staging (with the stub) and uploads the table as an artifact.

## 5. Tenancy & security

Load test uses one dedicated demo property; never point it at a real guest property.

## 6. Test plan (named cases)

- `tests/load/thresholds.test.ts`: p95 computation with a fixed sample.
- `tests/db/explain.db.test.ts`: no sequential scan on the three hot queries at fixture scale.

## 7. Evidence to record in the runbook

- ``node scripts/load-test.ts` (p95 table)`
- `EXPLAIN plans`
- `CI artifact`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-2 (provider) + DEC-1 (UI)** — the stub makes the core measurement possible now, but the target load and the deployed surface depend on those decisions.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
