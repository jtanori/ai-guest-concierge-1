---
id: DF-02
title: Opportunity click tracking
sprint: DF
epic: Deferred to MVP-1.5
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S10-01]
labels: [sprint:DF, track:foundation, prio:P0]
milestone: Deferred to MVP-1.5
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/118
pickup: deferred
---

# DF-02 — Opportunity click tracking

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | DF |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S10-01 |
| Pickup | `deferred` |

## 1. Why / goal

Track booking-link clicks after the pilot against real traffic.

## 2. Acceptance criteria (backlog AC verbatim)

> A booking-link click is recorded and attributable.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (skipped — deferred to MVP-1.5)

- **Skipped by instruction.** When it returns: a `GET /c/:slug/book` redirect handler recording a `booking_link_clicked` event (already in `src/events/taxonomy.ts`), with a signed property-scoped link and no PII in the query string.
- Backlog rule: 'After the pilot, against real traffic' — do not pull this into the 69.75-day path.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**DEFERRED — explicitly out of MVP; no changes calculated (per user instruction to skip where not possible).**

Open decisions / blockers:

- Deferred — no changes calculated.

## 9. Definition of done

- [ ] _Deferred until after the pilot._
