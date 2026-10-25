---
id: S13-03
title: Launch checklist + GM go/no-go
sprint: S13
epic: S13 - Launch
track: Founder
estimate_days: 0.5
priority: P1
depends_on: [S13-01]
labels: [sprint:S13, track:foundation, prio:P1]
milestone: S13 - Launch
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/108
pickup: external
---

# S13-03 — Launch checklist + GM go/no-go

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S13 |
| Track / days / priority | Founder · 0.5d · P1 |
| Depends on | S13-01 |
| Pickup | `external` |

## 1. Why / goal

Written go/no-go from the GM.

## 2. Acceptance criteria (backlog AC verbatim)

> Written go/no-go from the GM.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Create `docs/pilot/LAUNCH-CHECKLIST.md`: G0–G3 evidence links, CI green, restore drill signed, staff trained, content corrected, `AI_FAIL_MODE=none`, alert channels live, QR printed, roll/rollback procedure (revert to the previous Neon branch) and named on-call.
- Record the GM's written go/no-go with date and signature; tick `S13-03` and the W14 'Pilot live' milestone.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- Non-code. The final gate before W14 pilot live.

## 9. Definition of done

- [ ] Checklist complete.
- [ ] Written GM decision filed.
- [ ] Workbook ticked.
