---
id: WA-08
title: Shadow run on one property
sprint: WA
epic: WhatsApp track (W14-W16)
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [WA-03, WA-04, WA-06]
labels: [sprint:WA, track:foundation, prio:P0]
milestone: WhatsApp track (W14-W16)
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/116
pickup: decision
---

# WA-08 — Shadow run on one property

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | WA |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | WA-03, WA-04, WA-06 |
| Pickup | `decision` |

## 1. Why / goal

A clean shadow run precedes G5 (WhatsApp live).

## 2. Acceptance criteria (backlog AC verbatim)

> Clean shadow run on one property; no guest-facing errors.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (test/deploy procedure)

- `scripts/wa-shadow.ts`: mirror 20 curated guest questions through the WhatsApp adapter into a **test** conversation, assert each produces exactly one outbound message with a delivery event, and compare the answer quality with the web channel's `npm run eval` scores.
- Add `docs/runbook.md` G5 evidence block: delivery success rate, p95 ack, opt-out exercised, template fallback exercised, zero `outbox.status='dead'` rows.
- Feature-flag the channel with `WA_ENABLED` (env) so production stays web-only until G5.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-5 + Meta approvals (WA-06, W00-08).** Procedure and script are calculated; execution waits on the external approvals.

## 9. Definition of done

- [ ] Shadow run clean; G5 evidence filed.
- [ ] Workbook ticked.
