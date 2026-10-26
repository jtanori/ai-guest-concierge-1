---
id: S10-01
title: Event emission across the product
sprint: S10
epic: S10 - Analytics
track: Eng
estimate_days: 1.5
priority: P0
depends_on: [W00-19]
labels: [sprint:S10, track:foundation, prio:P0]
milestone: S10 - Analytics
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/94
pickup: ready
---

# S10-01 — Event emission across the product

> **APPROVED and implemented 2026-10-26.** Owner authorization to begin was given in the Arena conversation on 2026-10-26 ("begin S10-01"), together with the AC-1 scope decision recorded in §8. This charter was originally generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`; §4 below has been **rebased on the tree at `main` = `1e27542`**, because the original calculations were made against a base that predates S04–S09 and two of them were wrong in ways that matter (the migration number, and how much instrumentation already existed).

| | |
|---|---|
| Sprint | S10 |
| Track / days / priority | Eng · 1.5d · P0 |
| Depends on | W00-19 |
| Pickup | `ready` |

## 1. Why / goal

One append-only `events` table (D10) — dashboard numbers must reconcile exactly to raw events.

## 2. Acceptance criteria (backlog AC verbatim)

> Dashboard numbers reconcile exactly to raw events.

- **AC-1** All 18 canonical events (plan Appendix C / `src/events/taxonomy.ts`) are emitted from production paths, not just tests.
- **AC-2** Every event carries `org_id, property_id, conversation_id, channel, language, topic, created_at`.
- **AC-3** A seeded set of 100 actions produces exactly 100 matching event rows.

## 3. Scope

**In:** Event writer, instrumentation of S04–S09 paths, reconciliation test.

**Out:** Rollups (S10-02); dashboard (S10-03).

## 4. Calculated changes — REBASED on `main` = `1e27542`

The draft §4 was calculated against a base predating S04–S09. Two of its four bullets
were already wrong when this item was picked up, and the corrections are recorded here
rather than silently applied, because one of them changes what the item is.

**What the draft got wrong, and what was true instead:**

- It proposed migration `0022_events_hardening.sql`. **0022 is `citation_quotes`;
  0022–0028 are taken.** The migration is `0029_events_hardening.sql`. The draft's own
  instruction was to rebase on whatever merged first.
- It listed the instrumentation of S04–S09 paths as work to do. **Sixteen of the
  eighteen canonical events were already emitted from production paths** — S05/S06/S07
  emitted theirs as they were built, and S09-01/02/03 emitted `request_*`,
  `answer_flagged_wrong` and `knowledge_gap_*`. `emitEvent` had 22 call sites across
  seven modules before this item started. What was actually missing was not
  instrumentation but *proof* of it, plus the two hardening items and the
  reconciliation.

**What shipped:**

- `db/migrations/0029_events_hardening.sql` — three changes, none of them new
  behaviour:
  1. `REVOKE UPDATE, DELETE ON events FROM concierge_app` — 0007's exact pattern for
     `audit_log`. 0002's `ALTER DEFAULT PRIVILEGES` had left the app role *holding*
     both, so append-only rested entirely on 0003's trigger. The trigger stays: it is
     the layer that still refuses a superuser, who bypasses privileges but not
     triggers. Denial now happens twice and fails differently (42501 vs P0001), and
     both are asserted.
  2. `ADD CONSTRAINT events_payload_object CHECK (jsonb_typeof(payload) = 'object')` —
     `emitEvent` already refuses a non-object payload, so this constrains the path
     that goes *around* the writer. Without it a scalar payload makes every
     `payload->>'request_id'` read return NULL, which reads as "this event has no
     request" rather than "this event is malformed".
  3. `CREATE INDEX events_property_type_time ON events (property_id, event_type,
     created_at DESC)` — the read S10-02's rollups and every per-metric reconciliation
     make. 0001's two indexes are **kept deliberately**: the composite cannot serve a
     property-wide time-ordered scan, and `events_type` cannot serve a per-property
     one. Three indexes on an append-only table is the cheap side of the trade, since
     nothing here is ever updated.
- `src/events/reconcile.ts` — `reconcile(client, context, window?)` over eight metric
  pairs, one statement so every count comes from one snapshot, plus `describeDrift()`
  and an exported `RECONCILE_METRICS` so a test can pin the set itself. Each pair was
  checked against **every** INSERT site for its table rather than assumed; §8 records
  the two pairings that are not what they look like.
- `tests/db/events.db.test.ts` (15) and `tests/events/reconcile.test.ts` (7).
- `tests/db/schema.db.test.ts` and `tests/db/non-superuser.db.test.ts` updated for the
  new migration — both are drift guards that are *meant* to fire on a new migration,
  and both did.

## 5. Tenancy & security

Events are the analytics source of truth; `REVOKE UPDATE/DELETE` + FORCE RLS. `createEvent` already refuses a context-less event.

## 6. Test plan (named cases)

- `tests/db/events.db.test.ts`: 100 seeded actions → exact event counts; no UPDATE/DELETE possible as `concierge_app`; every event has all seven context fields; `staff_message_sent` present for repeated staff replies.
- `src/events/taxonomy.test.ts` (exists) pins the 18 names.

## 7. Evidence to record in the runbook

- ``npm run db:test` (reconciliation deltas = 0)`
- ``npm test``

## 8. Pickup status, blockers and decisions

**DONE 2026-10-26.** DEC-1 and DEC-2 are owner decisions taken in the Arena
conversation; DEC-3 and DEC-4 are findings from reading the code, recorded because each
one changes what a future reader would otherwise assume.

- **DEC-1 (owner, 2026-10-26) — AC-1 is met for 16 of 18 events; two are deferred.**
  `booking_link_clicked` and `outbound_webhook_delivered` have **no producer anywhere in
  the product**: their only appearances are `src/events/taxonomy.ts` and its test. The
  features that would produce them are DF-02 (opportunity click tracking) and DF-01
  (outbound webhook per property), both deferred to MVP-1.5 and neither started. The
  owner chose to **defer** rather than pull either forward. Consequences, all deliberate:
  - Both names **stay** in `EVENT_NAMES` and in 0001's CHECK constraint as reserved
    taxonomy. Deleting them would churn the taxonomy and lose the names DF-01/DF-02 need.
  - A test asserts they are *declared but unemitted*, so wiring a producer for either
    one **fails the suite** until this charter is updated. The deferral is enforced, not
    remembered.
  - AC-1 therefore reads 16/18, and the workbook row is 🚧 rather than ✅ — see DEC-2.
- **DEC-2 — the workbook status is 🚧, not ✅.** The backlog AC is verbatim "all 18
  canonical events", and two are not emitted, so the AC is not objectively met however
  sensible the deferral is. `✅` in this repository means the AC was met and verified;
  using it here would make the workbook the only place that claims a completeness the
  code does not have. The pending half is DF-01/DF-02.
- **DEC-3 — `request_assigned` pairs with `assignments`, not with `service_requests`.**
  One request can carry several assignees, so counting requests against those events
  under-reports by one per additional assignee and reads as missing instrumentation.
  Two INSERT sites feed it (`lifecycle.ts` for the first assignee, `inbox/actions.ts`
  for an additional one) and they are **mutually exclusive**, not a double emission —
  `actions.ts` returns early after `transitionRequest` and only emits directly on the
  append-only additional-assignee path.
- **DEC-4 — `ai_runs` cannot be paired with one event type.** `recordAiRun` is called
  from four paths in `src/ai/answer.ts` and each emits a *different* terminal event:
  `ai_run_completed` on the success path, `message_failed` for a provider outage, and
  `ai_escalated` for the policy-block and guardrail gates. Counting one type
  under-reports; counting all three over-reports, because `ai_escalated` is also
  emitted on paths that never record a run. All four carry `ai_run_id` in the payload,
  so the reconciliation counts **distinct `payload->>'ai_run_id'`**, which is the exact
  image of the table.
- **CAVEAT — the demo seed does not reconcile, and cannot.** `src/seed/demo.ts` has
  **zero** `emitEvent` calls: it writes business rows (including `knowledge_gaps`)
  directly. A demo property's dashboard numbers will therefore not reconcile to its
  events, because its rows were never actions. Reconciliation is defined over rows
  written through production code. Making the seed emit would change what the fixture
  means, and wanting that is S10-03's decision, not this item's assumption.
- **`src/events/emit.ts` is unchanged**, honouring the S10-01-A approval's exclusion of
  taxonomy and writer changes. That limited package (`emit.ts` + `emit.test.ts`) is
  merged and is reconciled into this charter here, as its approval document required.

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview`, `eval`.
- [x] Runbook entry in `docs/runbook.md` (`## S10-01`) with the exact commands and counts.
- [x] Workbook updated via `scripts/update-workbook-status.mjs` — to 🚧, **not** ✅, per DEC-2: AC-1 is 16/18 until DF-01/DF-02 give the last two events a producer.
- [x] No new table, no new route, no new runtime dependency. Tenancy is asserted in `reconcile()` (a neighbour's rows cannot mask a gap) and by 0029's REVOKE.
- [ ] Review threads resolved. DEC-1…DEC-4 and the seed caveat are recorded above and summarised in the runbook.

## Limited package authorization

See [parallel-work approval](../approvals/parallel-work.md). Only `S10-01-A` is owner-authorized, effective after the documentation PR merges. This parent charter remains draft and its full AC is unchanged.
