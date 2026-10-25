---
id: S11-05
title: Nightly embedding reconciliation
sprint: S11
epic: S11 - Reliability
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S02-05, S04-02]
labels: [sprint:S11, track:foundation, prio:P0]
milestone: S11 - Reliability
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/101
pickup: ready
---

# S11-05 — Nightly embedding reconciliation

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S11 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S02-05, S04-02 |
| Pickup | `ready` |

## 1. Why / goal

Detect stale chunks before a guest is quoted a deleted policy.

## 2. Acceptance criteria (backlog AC verbatim)

> Job fails loudly on a seeded drift case.

- **AC-1** Three invariants: every current article version has ≥1 chunk; every chunk resolves to a current version; no chunk outlives its parent.
- **AC-2** A seeded drift case fails the job with a non-zero exit and a named violation.

## 3. Scope

**In:** Reconciliation script, invariants, scheduled job.

**Out:** Auto-repair (deliberate — alert, don't silently fix).

## 4. Calculated changes (for the coding agent)

- `scripts/reconcile-embeddings.ts` + `src/knowledge/reconcile.ts`: three SQL assertions over `article_versions` and `article_chunks` (S04-02), each returning violating ids; print a table and `process.exit(1)` on any violation. **Do not auto-repair** — a silent fix hides the broken publish path.
- Add `"reconcile": "node --experimental-strip-types scripts/reconcile-embeddings.ts"` and a `reconcile-nightly.yml` workflow; emit the `embedding_drift_total` counter consumed by S11-04.
- Seed a drift case in the DB test: insert a chunk whose parent is not `is_current`, and delete the chunks of a current version.

## 5. Tenancy & security

Reconciliation runs per property (iterate properties and set GUCs); a single-tenant failure must not mask others.

## 6. Test plan (named cases)

- `tests/db/reconcile.db.test.ts`: all three violations detected individually; clean fixture passes; cross-tenant chunk cannot satisfy another tenant's invariant.

## 7. Evidence to record in the runbook

- ``npm run reconcile` (clean)`
- `seeded drift → exit 1 + named violation`

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — depends on S04-02's `article_chunks` table.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
