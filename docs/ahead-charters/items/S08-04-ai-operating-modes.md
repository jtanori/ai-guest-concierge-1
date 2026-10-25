---
id: S08-04
title: AI operating modes
sprint: S08
epic: S08 - Staff inbox
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S08-03]
labels: [sprint:S08, track:foundation, prio:P0]
milestone: S08 - Staff inbox
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/88
pickup: ready
---

# S08-04 — AI operating modes

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S08 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S08-03 |
| Pickup | `ready` |

## 1. Why / goal

Mode change applies to the next message, no deploy (D6).

## 2. Acceptance criteria (backlog AC verbatim)

> Mode change applies to the next message, no deploy.

- **AC-1** `auto | draft | human_only | after_hours` selected per property in `property_settings`.
- **AC-2** Flipping the mode changes the very next message's decision without restart; `draft` escalates, `after_hours` uses the property's `time_zone`.

## 3. Scope

**In:** Settings surface + policy wiring for modes; proof of no-restart behaviour.

**Out:** New modes; mode-scheduled automation.

## 4. Calculated changes (for the coding agent)

- `src/settings/schema.ts` already has `ai_mode` + `business_hours` + `escalation` + `spend_cap`; `src/settings/policy.ts::escalationDecision` is pure and reads settings per call — so the requirement is **wiring, not new policy code**.
- `src/settings/store.ts::savePropertySettings` is the write path (S02-02); add a `POST /staff/settings/ai-mode` route with `session.requireRole('settings','write')` and an audit row `settings.updated`.
- `src/ai/policy.ts` (S05-02) must call `loadPropertySettings` on **every** message (no module-level cache) — add a test that mutates settings between two `answerMessage` calls in the same process and observes the decision change.
- Add `staff.mode.*` strings to `src/i18n/catalog.ts` in both languages.

## 5. Tenancy & security

Settings are per property; `loadPropertySettings` already scopes by context — assert a cross-tenant mode flip cannot affect another property.

## 6. Test plan (named cases)

- `tests/db/ai-modes.db.test.ts`: flip auto→human_only→after_hours in one process; DST/weekend `isAfterHours` cases; foreign property unaffected.
- `tests/settings/policy.test.ts` (exists) for the pure decisions.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- ``npm test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — the pure policy already exists; this is mostly a route + a no-cache guarantee. Depends on S05-02's policy gate being wired.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
