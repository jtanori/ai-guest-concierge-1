---
id: W00-14
title: Error tracking + structured logging
sprint: W00
epic: W00 - Foundation lock
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [W00-13]
labels: [sprint:W00, track:foundation, prio:P0]
milestone: W00 - Foundation lock
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/60
pickup: ready
---

# W00-14 — Error tracking + structured logging

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | W00 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | W00-13 |
| Pickup | `ready` |

## 1. Why / goal

Promote the existing logger/error reporter into a wired, tenant-context-aware observability baseline.

## 2. Acceptance criteria (backlog AC verbatim)

> Structured logs with tenant context; an uncaught error reaches the tracker with a runbook link.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (for the coding agent)

- `src/logging/index.ts` already exports `createLogger`, `bindRequestContext` and `reportError` — wire `reportError` into every route handler in `src/server.ts` (replace the bare 503 catch).
- Add `docs/runbook.md` error-catalogue section: one line per alert with a link back to the runbook heading.
- Add `tests/logging/redaction.test.ts` seeded synthetic PII to prove no card/email reaches the log (overlaps S11-03 — keep the seed shared).
- Tick `W00-14` in the workbook with the CI log.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- ``npm test``
- `CI log showing one seeded error round-trip`

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- Provider (Sentry/GlitchTip/etc.) is a new dependency decision — record it in the ADR log or keep the pino JSON sink + `reportError` hook and note the choice in the runbook.

## 9. Definition of done

- [ ] A seeded error is visible with org/property context.
- [ ] Runbook `W00-14` entry DONE.
- [ ] Workbook ticked.
