---
id: S12-01
title: Runbook + backup restore drill
sprint: S12
epic: S12 - Pilot readiness
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S11-04]
labels: [sprint:S12, track:foundation, prio:P0]
milestone: S12 - Pilot readiness
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/102
pickup: ready
---

# S12-01 — Runbook + backup restore drill

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S12 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S11-04 |
| Pickup | `ready` |

## 1. Why / goal

G3 cannot pass without a timed restore.

## 2. Acceptance criteria (backlog AC verbatim)

> Restore completed and timed; runbook signed.

- **AC-1** A Neon branch restore into a scratch database is executed and timed end to end.
- **AC-2** Post-restore integrity checks pass (migration chain, RLS isolation suite, row counts).

## 3. Scope

**In:** Restore procedure, timing evidence, runbook sign-off, alert anchors.

**Out:** Disaster-recovery automation beyond the drilled procedure.

## 4. Calculated changes (for the coding agent)

- `docs/runbook.md`: add `## S12-01 — Backup restore drill` with the exact Neon branch/restore commands, the elapsed time, and a verification block (`npm run db:migrate`, `npm run db:test`, `select count(*)` per tenant table).
- `scripts/verify-restore.ts`: compare pre/post row counts for the 25+ tenant tables (reuse `tests/db/schema.db.test.ts`'s table enumeration) and assert the isolation suite result.
- Ensure every `runbookAnchor` in `src/observability/alerts.ts` (S11-04) resolves to a real heading — add a test that parses `docs/runbook.md` headings.
- Record signer + date in the workbook tick.

## 5. Tenancy & security

Restore drill must use a scratch database, never staging/prod; no guest data copied into a local env without the W00-18 data-flow approval.

## 6. Test plan (named cases)

- `tests/observability/alerts.test.ts` (exists from S11-04) — anchor coverage.
- `tests/db/verify-restore.test.ts`: table enumeration completeness.

## 7. Evidence to record in the runbook

- `timed restore transcript`
- ``npm run db:test` on the restored DB`
- `signed runbook entry`

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — procedural, no external provider decision; needs access to the Neon console.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
