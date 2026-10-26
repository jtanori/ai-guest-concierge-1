---
id: S09-03
title: One-click 'wrong or outdated'
sprint: S09
epic: S09 - Requests and notifications
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S08-02, S05-03]
labels: [sprint:S09, track:foundation, prio:P0]
milestone: S09 - Requests and notifications
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/91
pickup: done
---

# S09-03 — One-click 'wrong or outdated'

> **Approved to start by the user on 2026-10-26** as part of the S09-01…S09-05 sequence. The draft notice below is retained for provenance; §4 was rebased on the merged baseline and the deviations are recorded in §8 and in the runbook.

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S08-02, S05-03 |
| Pickup | `done` (2026-10-26) |

## 1. Why / goal

A flag is attributable to the exact `ai_run` that produced the answer.

## 2. Acceptance criteria (backlog AC verbatim)

> A flag is attributable to an ai_run.

- **AC-1** One click creates a flag row with `ai_run_id`, staff user id, timestamp and optional note.
- **AC-2** The flag is visible on the conversation detail view and emits `answer_flagged_wrong`.

## 3. Scope

**In:** Flag table, route, event, detail-view indicator.

**Out:** Review queue (S09-04); retraining/automated fixes.

## 4. Calculated changes (for the coding agent)

- Migration `0020_answer_flags.sql`: `answer_flags(org_id, property_id, flag_id uuid PK, ai_run_id uuid NOT NULL, flagged_by uuid NOT NULL REFERENCES users, note text, created_at timestamptz DEFAULT now(), UNIQUE (org_id,property_id,ai_run_id,flagged_by), composite FK → ai_runs)` + FORCE RLS + policy + grants.
- `src/inbox/flags.ts`: `flagAnswer(client, context, session, aiRunId, note?)` — `session.requireRole('queue','write')`, verify the `ai_run` is visible in this tenant, insert, `createEvent('answer_flagged_wrong', {ai_run_id})`.
- Wire the `data-ai-run-id` hook from S08-02 into `POST /staff/answers/:aiRunId/flag`; add `staff.flag.*` catalogue strings (ES+EN).

## 5. Tenancy & security

Composite FK prevents citing another tenant's `ai_run`; add to isolation + schema suites.

## 6. Test plan (named cases)

- `tests/db/flags.db.test.ts`: flag attributable, one per user/run, foreign `ai_run_id` → not found, event emitted.

## 7. Evidence to record in the runbook

- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**DONE — user approved the S09 sequence on 2026-10-26.** Dependencies satisfied: S08-02's detail view already renders `data-ai-run-id` on every AI bubble (its own test called it "the S09-03 flag affordance"), and S05-03's `ai_runs` rows are what a flag names.

Deviations from §4, all recorded in the runbook:

- **Migration is `0026`, not `0020`.** `0020_embed_settings.sql` exists; §4's number was calculated against a pre-S07 tree.
- **Route is `POST /api/inbox/answers/:aiRunId/flag`**, not `/staff/answers/...` — there is no `/staff` prefix, and the flag is inbox work (`queue: write`), so it joins the inbox route table rather than growing a fourth dispatcher branch.
- **`createEvent` → `emitEvent`**, as for S09-01 and S09-02.
- **The note is optional but cannot be added later.** §4 says "optional note" without saying when; because the table is append-only the note has to ride in the same request as the flag, so the input sits in the same form as the button rather than behind a second one.
- **No flagger names on screen.** §4 did not anticipate this: 0004's `users.staff_select` policy authorises *your own row only*, so a join for a colleague's `display_name` returns NULL for everyone else. Widening that policy would expose staff names and emails across a property — an S02 security decision, not something to slip into this item. The wire carries `flaggedBy` (the UUID the AC asks for) and `mine`; the screen shows a count and the notes.
- **Append-only needed an explicit REVOKE.** `GRANT SELECT, INSERT` does not restrict anything: 0002 runs `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO concierge_app`, so the `CREATE TABLE` had already granted all four. Found by asserting the privilege instead of assuming it. 0026 now revokes UPDATE/DELETE (0007's `audit_log` precedent) and adds 0003's `raise_immutable()` trigger.
- **Three drift guards had to be updated, and each earned its keep:** `tests/db/isolation.db.test.ts` (tenant-table list, derived from the database's own policies), `tests/db/schema.db.test.ts` (migration list, table count, and the committed ERD in `db/erd.mmd`), `tests/db/non-superuser.db.test.ts` (migration count). Adding `answer_flags` to the isolation list made the cross-tenant sweep cover it for free.

## 9. Definition of done

- [x] Implemented and measured locally: `db:migrate` 26 from empty, `db:test` 36 files / 352, `npm test` 45 files / 570, root+web `tsc` clean, `lint` clean, `web:build` green. Runbook entry `## S09-03 - One-click 'wrong or outdated' (0.50d)`.
- [x] Cross-tenant isolation suite extended for the new table (`answer_flags` in `EXPECTED_TENANT_TABLES`, seeded in both tenants) and for the new route (a foreign run is 404 and writes nothing; the composite FK refuses the reference with the application layer bypassed entirely). ERD updated. No new runtime dependency.
- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
