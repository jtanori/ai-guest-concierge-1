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
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/88
pickup: done
---

# S08-04 — AI operating modes

> **DONE (2026-10-26), shipped in PR #144.** Most of the item already existed
> (S05-02's pure policy is mode-aware and `answerMessage` re-reads the mode per
> message); what shipped here is the surface, the proof, and two corrections to
> the plan — see §10.
>
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

**CLOSED.** No blocking decisions; two plan corrections, both recorded in §10.

- **Where the mode lives.** The charter says `property_settings`. There is no
  such table: the mode is `properties.ai_mode` (0001), a column with a CHECK, and
  that is what the policy gate, the seed and every existing test read.
- **`draft` is not rejected.** §4 of the plan text (quoted in 0001's comment)
  said draft is not a pilot mode; 0001's CHECK allows it and the four-mode
  decision table has always handled it. Shipped as allowed — the item's own AC-1
  lists `draft`.

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [x] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval. (No new dependency; the cross-tenant read/write cases are named tests.)
- [x] Review threads resolved; charter §9 decisions recorded in the runbook.

## 10. Close-out

**AC-1 — `auto | draft | human_only | after_hours`, per property.** Met, and it
was already true of the storage: `properties.ai_mode` is a column with a CHECK
naming exactly these four values (0001), read by `answerMessage` and passed to
`policyGate` on every turn. What this item adds is a **surface**:
`GET|POST /api/settings/ai-mode` behind the shared staff pipeline
(`settings: read|write`), and `src/settings/mode.ts`, which validates the closed
set, refuses a no-op write (no audit spam from a double click) and audits
`settings.updated` with `previous` and the new value.

**AC-2 — flipping the mode changes the very next message, no restart.** Met, and
proven rather than asserted: `tests/db/ai-modes.db.test.ts` flips the mode through
the HTTP route and sends the next message **in the same process, on the same pool,
with no reload**, for `human_only` → `mode_human_only`, `draft` → `mode_draft`, and
`after_hours` → answers inside the property's business hours and escalates outside
them. The provider in that test counts its calls, so "the model was not consulted"
is a number (`calls() === 0`) rather than a decision string a called model could
also have produced.

There is nothing to invalidate anywhere: `answerMessage` SELECTs
`ai_mode, time_zone, languages, settings` at the top of each turn and passes them
down. A module-level cache would have been the only way to break this AC, so none
exists — and the test would catch one being added.

**after_hours uses the property's `time_zone`, not UTC.** 15:00Z is 09:00 in
Mexico City (open) and 04:00Z is 22:00 the previous local day (closed); both are
asserted against the same settings row. A DST case was added to the pure policy
suite (`tests/settings/policy.test.ts`): 13:30Z is 08:30 on 2026-03-07 and 09:30 on
2026-03-08 in New York, so the same UTC hour crosses the open/close line.

**Path correction.** The charter's `POST /staff/settings/ai-mode` is
**`/api/settings/ai-mode`** — every staff surface in this repository has been
`/api/*` behind `handleStaffRequest` since S04-01, and the settings screen is a
Next page at `/settings`.

**A real dispatcher bug, found by this item.** `/api/settings/ai-mode` is the
first resource with both a GET and a POST, and `handleStaffRequest` matched the
route on the *path only*, then answered 405 when the method differed. Two routes
on one path would have been permanently unreachable. It now matches on path and
method, and sets `Allow` from every method registered for that path.

**A regression found in passing, and the guard for it.** S08-03's
`RequestNotActionableError` used a TypeScript parameter property
(`constructor(readonly reason: ...)`). Node's `--experimental-strip-types` refuses
that syntax, so the API could not boot at all — while `typecheck`, `test`,
`db-test` and the whole CI matrix were green, because both `tsc` and vitest
compile it happily. Fixed, and `tests/runtime/strip-types.test.ts` now imports
**every** module under `src/` (except `server.ts`, which binds a port) in a child
process with the server's own flags, failing on
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Verified against a probe: the guard fails
with a parameter property planted in `src/`, and passes without it.

**The screen.** `/settings` renders the four modes as radios with the consequence
in the hint text (an admin who thinks "draft" means silence will turn it on
expecting silence), reads the current mode from the API rather than from the form,
and saves through a server action. `properties` has no `updated_at` column, so the
change record is the audit row — which is the more useful answer anyway.

**Not done, by scope:** scheduled mode changes, per-channel modes, and any new
mode. Also unchanged: nothing else may bypass `policyGate` — the guest turn, the
handoff tap and the AI writer all still go through it.

**Evidence:**

- `npm run db:migrate` — 23 applied (no new migration this item).
- `npm run db:test` — **33 files / 279 passed** (7 mode cases).
- `npx vitest run` — **43 files / 531 passed** (5 pure mode cases, 1 DST case,
  1 runtime guard).
- `npx tsc --noEmit` and `npm run lint` clean, root and `web/`.
- `npm run web:build` green; `/settings` in the manifest.
- live `GET /api/settings/ai-mode` → 503 `NEON_AUTH_JWKS_URL is required` (the
  same degraded-host contract as the other staff routes).
