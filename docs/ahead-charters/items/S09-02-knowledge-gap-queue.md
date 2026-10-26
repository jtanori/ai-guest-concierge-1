---
id: S09-02
title: Knowledge-gap queue
sprint: S09
epic: S09 - Requests and notifications
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S05-02]
labels: [sprint:S09, track:foundation, prio:P0]
milestone: S09 - Requests and notifications
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/90
pickup: done
---

# S09-02 — Knowledge-gap queue

> **Approved to start by the user on 2026-10-26** as part of the S09-01…S09-05 sequence. The draft notice below is retained for provenance; the calculated changes in §4 were rebased on the merged baseline and the deviations are recorded in §8 and in the runbook.

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S09 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S05-02 |
| Pickup | `done` (2026-10-26) |

## 1. Why / goal

Every no-answer must land in a queue so the content owner knows what to write next.

## 2. Acceptance criteria (backlog AC verbatim)

> Every no_answer lands in the queue automatically.

- **AC-1** Each `no_answer` creates/updates one `knowledge_gaps` row with the verbatim question, language and property.
- **AC-2** Close produces `knowledge_gap_closed`; median age is computable.

## 3. Scope

**In:** Gap upsert, queue query, close action, median-age metric.

**Out:** Gap analytics tile (S10-03).

## 4. Calculated changes (for the coding agent)

- `knowledge_gaps` already exists in 0001 (`gap_id, conversation_id, question, language, status, created_at, resolved_at`). Add `src/gaps/queue.ts`: `recordGap` (dedupe on `(property_id, lower(question))` within 7 days via a partial unique index in `0019_gaps.sql`), `listOpenGaps`, `closeGap(client, context, gapId)` setting `resolved_at` + `status='resolved'`.
- Migration `0019_gaps.sql`: `CREATE UNIQUE INDEX knowledge_gaps_open_question ON knowledge_gaps (property_id, lower(question)) WHERE status='open'`; index `(property_id, status, created_at)`; add `topic text` and `hits integer NOT NULL DEFAULT 1` so repeats increment rather than spam the queue.
- `src/gaps/metrics.ts`: `medianOpenAgeDays(client, context)` — a pure SQL `percentile_cont(0.5) within group (order by extract(epoch from now()-created_at))` (target ≤7 days, Appendix D).
- Emit `knowledge_gap_created` / `knowledge_gap_closed` via `createEvent`.

## 5. Tenancy & security

Dedupe key includes `property_id`; add `knowledge_gaps` to the isolation sweep.

## 6. Test plan (named cases)

- `tests/db/gaps.db.test.ts`: duplicate question increments hits (one row); close sets `resolved_at`; median age computation; cross-tenant isolation.

## 7. Evidence to record in the runbook

- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**DONE — user approved the S09 sequence on 2026-10-26; implemented on the S09-01 head.**

Dependency check: **S05-02 is satisfied for this item's purposes.** §4 assumed the no-answer paths would have to be written; they already exist (`src/ai/answer.ts`, two of them — empty retrieval and the model's own `no_answer`), and both already wrote a gap row. What was missing was the queue: dedupe, hits, close, median.

Deviations from §4, all recorded in the runbook:

- **Migration is `0025`, not `0019`.** `0019_abuse_and_spend.sql` exists; §4's number was calculated against a pre-S07 tree.
- **There were already two writers, and that was the actual bug.** §4 proposed adding `recordGap` alongside them. Instead `src/ai/answer.ts` and `src/requests/capture.ts` now both go through the one `recordGap`; capture's old guard was scoped to the *conversation*, so the same question in a second conversation was a second row.
- **No 7-day dedupe window.** A partial unique index cannot express one, and a question asked for 30 days straight is better served by one row with `hits = 30` than by four rows. The index is `WHERE status = 'open'`, so closing a gap lets the same question open a fresh one.
- **`question_key` is a generated column, capped at 400 characters and folded with `translate()` before `lower()`.** Neither was in §4. The cap is because a btree key is limited to ~2704 bytes and guest messages may be 2000 multi-byte characters — indexing `lower(question)` directly would make a long question an insert *error*. The fold is because `lower()` is ASCII-only under a C collation, which would split every shouted Spanish question into two entries.
- **One ask per turn, not per writer.** A no-answer turn calls `recordGap` twice (pipeline, then capture) inside one transaction; `hits` increments only when the existing row's `xmin` is not the current transaction, so the count is guests rather than code paths.
- **Route is `GET /api/gaps` + `POST /api/gaps/:id/close`** behind the shared staff pipeline, on the `knowledge` surface (`read` for the queue, `write` to close — a front desk may read it and may not claim the content exists).
- **`createEvent` → `emitEvent`**, as for S09-01.

## 9. Definition of done

- [x] Implemented and measured locally: `db:migrate` 25 from empty, `db:test` 35 files / 336, `npm test` 45 files / 567, root+web `tsc` clean, `lint` clean, `web:build` green with `/gaps` in the manifest. Runbook entry `## S09-02 - Knowledge-gap queue (0.50d)`.
- [x] Cross-tenant isolation covered for the new route in `tests/db/gaps.db.test.ts` (queue never crosses properties; another tenant's gap is 404, not 403). No new runtime dependency.
- [x] Merge path verified against a real pre-0025 database with duplicates seeded — the branch a fresh scratch database never reaches. See the runbook.
- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
