---
id: W00-01
title: ADR review meeting, D1-D14
sprint: W00
epic: W00 - Foundation lock
track: Founder
estimate_days: 0.25
priority: P1
depends_on: []
labels: [sprint:W00, track:foundation, prio:P1]
milestone: W00 - Foundation lock
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/47
pickup: external
---

# W00-01 — ADR review meeting, D1-D14

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | W00 |
| Track / days / priority | Founder · 0.25d · P1 |
| Depends on | — |
| Pickup | `external` |

## 1. Why / goal

Lock the fourteen Week-0 decisions in writing so no later sprint improvises one of the irreversible calls.

## 2. Acceptance criteria (backlog AC verbatim)

> All fourteen have an owner and a decision.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Deliverables (documents / approvals — no code)

- Create `docs/decisions/ADR-LOG.md`: one row per D1–D14 (plan §2) with `decision`, `owner`, `date`, `reversibility`, `status=proposed|accepted`, and a link to the evidence.
- D1 (RLS + app guard), D5 (cite `article_version_id`), D11 (WhatsApp provider), D14 (ES/EN catalogue) must be `accepted` before any code starts.
- Cross-check against `docs/05-kickoff-pack-week0.md` §2 so the ADR IDs match.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- ``grep -c 'status=accepted' docs/decisions/ADR-LOG.md` → 14`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- No code blocker — but the ADR log is the input to DEC-2 (LLM models), DEC-3 (embedding model) and DEC-5 (WhatsApp provider) in `README.md`.

## 9. Definition of done

- [ ] Objective evidence attached (document, screenshot, email or CI log).
- [ ] Workbook ticked with `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"`.
- [ ] G0 review (W00-20) records the decision and the signer.
