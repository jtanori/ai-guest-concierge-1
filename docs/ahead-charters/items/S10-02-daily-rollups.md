---
id: S10-02
title: Daily rollups
sprint: S10
epic: S10 - Analytics
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S10-01]
labels: [sprint:S10, track:foundation, prio:P0]
milestone: S10 - Analytics
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/95
pickup: ready
---

# S10-02 — Daily rollups

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S10 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S10-01 |
| Pickup | `ready` |

## 1. Why / goal

Recompute any historical date without drift — SQL over events, no second pipeline.

## 2. Acceptance criteria (backlog AC verbatim)

> A historical date can be recomputed without drift.

- **AC-1** `npm run rollup -- --date YYYY-MM-DD` is idempotent (same numbers on re-run).
- **AC-2** Rollup values equal a direct `SELECT count(*) ... FROM events` for that date.

## 3. Scope

**In:** Rollup SQL, script, idempotent upsert, metric definitions.

**Out:** Dashboard rendering (S10-03).

## 4. Calculated changes (for the coding agent)

- `scripts/rollup.ts` + `src/analytics/rollups.ts`: one `INSERT ... ON CONFLICT (property_id, metric, window_start, granularity) DO UPDATE SET value=EXCLUDED.value, generated_at=now()` statement per metric, all computed from `events` grouped by `(property_id, date_trunc('day', created_at))` in the **property's** `time_zone` (fix the S03-03 `CURRENT_DATE` timezone lesson: `((created_at AT TIME ZONE p.time_zone)::date)`).
- Metrics from Appendix D: `conversations_started`, `messages_received`, `ai_answers_sent`, `escalations`, `no_answers`, `containment` (conversations with zero `staff_message_sent`), `first_response_p95_seconds`, `requests_created`, `requests_acknowledged`, `ack_median_seconds`, `knowledge_gaps_opened/closed`. Store each as a row in `rollups` (0001: `metric, granularity, window_start, value, generated_at`, UNIQUE already present).
- Add `"rollup": "node --experimental-strip-types scripts/rollup.ts"` to `package.json`; support `--from/--to` backfill and `--dry-run`.
- Add a scheduled CI workflow `rollup-nightly.yml` (or a cron in the hosting platform) that recomputes the last 3 days so late events are absorbed.
- **Before wiring any of this to `reconcile()`'s `from`/`to`:** read issue #147 and the caveat on `ReconcileWindow` in `src/events/reconcile.ts`. The nightly 3-day recompute is the first thing to sit on a window boundary where the business-table clock and the event clock disagree, so edge deltas of ±1 are expected and must be tolerated, not alerted.

## 5. Tenancy & security

Rollup queries must group by `org_id, property_id` and write both columns; add `rollups` to the isolation suite.

## 6. Test plan (named cases)

- `tests/db/rollups.db.test.ts`: recompute the same date twice → identical; late event recompute changes only that date; direct count equals rollup; two properties never mix.
- `tests/analytics/rollups.test.ts`: timezone boundary (02:00 UTC is the prior local day).

## 7. Evidence to record in the runbook

- ``npm run rollup -- --date 2026-10-25``
- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — `rollups` table exists; no external decision. Note the timezone fix must be applied here even though it was raised on S03-03.

- **BLOCKED ON A DECISION, not on code — [issue #147](https://github.com/jtanori/ai-guest-concierge-1/issues/147) must be resolved before or alongside this item.** S10-01 shipped `src/events/reconcile.ts` with a windowed path (`from`/`to`), and this charter's `--from/--to` backfill plus the nightly 3-day recompute are its **first production consumers**. The two sides of that window are not on the same clock: business tables take `created_at timestamptz DEFAULT now()` (the Postgres transaction timestamp, 0001:107/126/158/176/299/344) while the paired event takes a JS-side `new Date()` (`src/requests/capture.ts:109`, passed as `createdAt` at :184; no business INSERT in `src/` supplies `created_at`). A window boundary between those two readings yields `delta ±1` — a timing artifact, not missing instrumentation — and a backfill that recomputes "the last 3 days" sits exactly on such a boundary.
  - Consequence for this item: **any rollup that is verified against a windowed `reconcile()` must treat a `delta ±1` at its edges as advisory.** Whatever alerts or fails a backfill on a non-zero delta needs an explicit tolerance or an edge exclusion, or it will page on an artifact.
  - The three ways to remove it properly are in #147. Option 3 — producers pass their business row's `created_at` from `INSERT ... RETURNING` into the event context — is the one that actually honours D10's "reconcile exactly" promise, and it touches every emission site, so it is the owner's call, not the implementer's. The artifact is pinned by a test today (`tests/db/events.db.test.ts`, a pair whose two rows carry deliberately different timestamps), so choosing option 3 will fail that test and force the record to be updated.
  - S10-01's own AC-1 is unaffected: the unwindowed reconciliation is the authoritative one and reconciles exactly.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
