---
id: S10-03
title: Management dashboard
sprint: S10
epic: S10 - Analytics
track: Eng
estimate_days: 2.0
priority: P0
depends_on: [S10-02]
labels: [sprint:S10, track:foundation, prio:P0]
milestone: S10 - Analytics
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/96
pickup: decision
---

# S10-03 — Management dashboard

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S10 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S10-02 |
| Pickup | `decision` |

## 1. Why / goal

Every tile traceable to a query a manager can explain.

## 2. Acceptance criteria (backlog AC verbatim)

> Every tile traceable to a query a manager can explain.

- **AC-1** Each tile links to its `rollups.metric` name and the SQL that produced it.
- **AC-2** Numbers match `rollups` exactly (no client-side recomputation).
- **AC-3** ES + EN copy via the catalogue; no hardcoded strings.

## 3. Scope

**In:** Dashboard view, tile definitions, query links, ES/EN strings.

**Out:** Ad-hoc query builder; export to CSV (MVP-1.5).

## 4. Calculated changes (for the coding agent)

- `src/analytics/tiles.ts`: `TILES` array — `{id, metric, labelId, querySql, format}` where `querySql` is the exact statement from `src/analytics/rollups.ts` (single source, exported as a constant so the tile cannot drift).
- `src/analytics/dashboard.ts`: `getDashboard(client, context, {from,to,lang})` reads `rollups` only; computes no derived numbers in JS (formatting only).
- Route `GET /staff/analytics` with `session.requireRole('analytics','read')`; server-rendered HTML by default (DEC-1); add `staff.analytics.*` to `src/i18n/catalog.ts` in both languages.
- Add a 'show query' disclosure on each tile that renders `querySql` — the AC is literally traceability.

## 5. Tenancy & security

`getDashboard` takes `TenantContext`; add a two-property test with different values.

## 6. Test plan (named cases)

- `tests/db/dashboard.db.test.ts`: each tile equals its `rollups` row; no JS-derived metric; foreign property excluded.
- `tests/i18n/catalog.test.ts` (exists) for ES/EN parity.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- ``npm test``
- `dashboard screenshot in runbook`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-1 (UI rendering).** Tile definitions and queries are fully calculated; only markup waits on the framework decision.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
