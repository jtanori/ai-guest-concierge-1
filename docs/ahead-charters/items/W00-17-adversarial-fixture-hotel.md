---
id: W00-17
title: Adversarial fixture hotel
sprint: W00
epic: W00 - Foundation lock
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [W00-13]
labels: [sprint:W00, track:foundation, prio:P0]
milestone: W00 - Foundation lock
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/63
pickup: ready
---

# W00-17 — Adversarial fixture hotel

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | W00 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | W00-13 |
| Pickup | `ready` |

## 1. Why / goal

Close out the messy fixture that chunking/retrieval are tested against.

## 2. Acceptance criteria (backlog AC verbatim)

> Six adversarial content cases present and asserted.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (for the coding agent)

- `src/fixtures/fixture-hotel.ts` already contains `MESSY_CASES` (6) and 7 article versions + 5 facts — verify the list against plan §4: flattened PDF table, OCR noise, contradictory pool hours, foreign-language spa price, 3,000-word article, picture-only noticeboard.
- Add `tests/knowledge/chunking.test.ts` assertions that the 3,000-word article yields >1 chunk, the picture-only article yields 0 and is refused publication, and the pool pair stays contradictory (connect to S04-02).
- Tick `W00-17` in the workbook with `docs/runbook.md:177` evidence.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- Evidence exists in the runbook; close-out only.

## 9. Definition of done

- [ ] Six cases asserted.
- [ ] Runbook `W00-17` entry DONE.
- [ ] Workbook ticked.
