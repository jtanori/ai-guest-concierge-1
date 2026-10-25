---
id: WA-06
title: Template submission + approval
sprint: WA
epic: WhatsApp track (W14-W16)
track: Founder
estimate_days: 1.0
priority: P1
depends_on: [W00-09]
labels: [sprint:WA, track:foundation, prio:P1]
milestone: WhatsApp track (W14-W16)
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/114
pickup: external
---

# WA-06 — Template submission + approval

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | WA |
| Track / days / priority | Founder · 1.0d · P1 |
| Depends on | W00-09 |
| Pickup | `external` |

## 1. Why / goal

Approved templates are calendar time — submit in W4, not W14.

## 2. Acceptance criteria (backlog AC verbatim)

> Templates approved; names and ids recorded.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Create `docs/pilot/WA-TEMPLATES.md` with the 3 required templates (out-of-window reply, escalation acknowledgement, re-engagement), each in ES + EN, with category, variables and submission date.
- Record approval status/id and wire the ids into `WA_TEMPLATES` in `src/config/env.ts` (WA-03 reads them).

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- Meta approval is external calendar time (starts W4 in the backlog). No engineering until approval — this is the item to start early.

## 9. Definition of done

- [ ] All templates approved with ids recorded.
- [ ] Workbook ticked.
