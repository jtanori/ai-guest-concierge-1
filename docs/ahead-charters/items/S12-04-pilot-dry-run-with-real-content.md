---
id: S12-04
title: Pilot dry run with real content
sprint: S12
epic: S12 - Pilot readiness
track: Both
estimate_days: 1.5
priority: P1
depends_on: [S12-01]
labels: [sprint:S12, track:foundation, prio:P1]
milestone: S12 - Pilot readiness
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/105
pickup: external
---

# S12-04 — Pilot dry run with real content

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S12 |
| Track / days / priority | Both · 1.5d · P1 |
| Depends on | S12-01 |
| Pickup | `external` |

## 1. Why / goal

Three hotel staff complete the flow unaided — the last gate before launch.

## 2. Acceptance criteria (backlog AC verbatim)

> Three hotel staff complete the flow unaided.

- **AC-1** Three named staff complete: guest question → AI answer → escalation → inbox → request → resolve, unaided.
- **AC-2** Every failure is logged as a content or product defect with an owner.

## 3. Scope

**In:** Dry-run script, staff sessions, defect log, G3 evidence.

**Out:** Fixing defects found (feeds S13-02).

## 4. Deliverables (documents / approvals — no code)

- Create `docs/pilot/DRY-RUN.md` with the scripted scenario list (at least 6: pool hours, spa price, allergen, refund, booking intent, accessibility), a per-staff result table and an unaided/assisted flag.
- Seed the real property content (25 articles / 40 facts / golden set v2) via the S03-02 CSV import; verify `listContradictions` is empty and `npm run eval` passes G2 before staff start.
- Capture timing (first response p95, ack median) from `rollups` and attach the transcript IDs (never raw guest PII) in the runbook.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time.**

Open decisions / blockers:

- Blocked by G1 content (W00-10/W00-16) and G2 (S06-03). No code — a supervised session. This is the critical-path item most likely to slip.

## 9. Definition of done

- [ ] Three staff complete unaided; evidence recorded.
- [ ] Defect log triaged into S13-02 or a follow-up item.
- [ ] G3 signed in `docs/runbook.md`.
