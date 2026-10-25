---
id: W00-18
title: Privacy notice + DPA to Mexican counsel
sprint: W00
epic: W00 - Foundation lock
track: Founder
estimate_days: 0.25
priority: P1
depends_on: []
labels: [sprint:W00, track:foundation, prio:P1]
milestone: W00 - Foundation lock
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/64
pickup: external
---

# W00-18 — Privacy notice + DPA to Mexican counsel

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | W00 |
| Track / days / priority | Founder · 0.25d · P1 |
| Depends on | — |
| Pickup | `external` |

## 1. Why / goal

LFPDPPP (effective 21 Mar 2025) makes the processor directly subject to the law; the DPA is the legal basis.

## 2. Acceptance criteria (backlog AC verbatim)

> Privacy notice and DPA sent to counsel; purposes enumerated explicitly.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Create `docs/legal/privacy-notice.md` and `docs/legal/dpa-template.md` enumerating purposes (chat answering, escalation, analytics, retention), the 90-day default retention, and the cross-border data-flow map (DB region, LLM provider, Meta, email, error tracking) from plan §5.
- Record counsel, send date and response in `docs/runbook.md`; link the retention policy to S11-03's deletion job.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- DEC-9 in `README.md` — S11-03's retention window and S07-04's Turnstile vendor are inputs to this.

## 9. Definition of done

- [ ] Objective evidence attached (document, screenshot, email or CI log).
- [ ] Workbook ticked with `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"`.
- [ ] G0 review (W00-20) records the decision and the signer.
