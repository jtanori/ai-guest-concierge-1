---
id: S08-02
title: Conversation detail with AI sources
sprint: S08
epic: S08 - Staff inbox
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S08-01, S05-03]
labels: [sprint:S08, track:foundation, prio:P0]
milestone: S08 - Staff inbox
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/86
pickup: done
---

# S08-02 — Conversation detail with AI sources

> **DONE (2026-10-26).** Shipped in PR #142; see §10 for the close-out and the one
> path correction (the detail route is `GET /api/inbox/conversations/:id`, not the
> `?conversation=` shape guessed here, and the quote now has a column of its own —
> migration **0022**). The banner below is kept as written, because the charter is
> a contract and its errors are part of the record.
>
> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S08 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S08-01, S05-03 |
| Pickup | `decision` |

## 1. Why / goal

Staff can see the cited text verbatim (D5 makes this possible).

## 2. Acceptance criteria (backlog AC verbatim)

> Staff can see the cited text verbatim.

- **AC-1** The detail view shows each AI message's citations with the exact `article_version` body/quote that was used.
- **AC-2** Editing the article later does not change what the staff member sees for an old answer.

## 3. Scope

**In:** Detail query + view + 'wrong or outdated' affordance hook (S09-03).

**Out:** Flagging persistence (S09-03); reply actions (S08-03).

## 4. Calculated changes (for the coding agent)

- `src/inbox/detail.ts`: `getConversationDetail(client, context, conversationId)` → `messages` + for each AI message the `ai_runs` row + `citations` joined to `article_versions.body` on the composite `(org_id, property_id, article_version_id)` — reuse `src/ai/history.ts::reconstructAnswer` from S05-03 rather than writing a second join.
- Show `model_id`, `prompt_version`, `decision`, `reason_code` and the exact quote; escape HTML (server-rendered default) to avoid stored XSS from guest messages.
- Add a `data-ai-run-id` attribute to each AI message block for S09-03's one-click flag.

## 5. Tenancy & security

Detail query must check `conversation_id` belongs to the context; foreign id → 404 (no existence leak).

## 6. Test plan (named cases)

- `tests/db/inbox-detail.db.test.ts`: cited text verbatim, survives a later article edit, foreign conversation 404, HTML-escaped guest body.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- `screenshot of the sources pane in runbook`

## 8. Pickup status, blockers and decisions

**CLOSED.** Both open questions were decided before any code was written; the
reasoning is in §10.

- **DEC-1 (UI rendering) — resolved by precedent, not by a new decision.** The
  staff surface has been React 19 / Next 15 server components / Tailwind /
  shadcn since S04-01, with copy in `src/i18n/catalog.ts` (D14). A detail page is
  a server component beside `web/app/(staff)/inbox/page.tsx`; it fetches through
  the same cookie session the inbox list uses.
- **DEC-2 (where the quote comes from) — the one real decision.** `citations` had
  no `quote` column (S05-03 shipped it that way and said so). Either show the
  whole `article_versions.body` and let staff find the sentence, or add the
  column. Decided: add it (**0022**), because the AC is *"the cited text
  verbatim"*, and one sentence is what the model actually used.

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [x] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval. (No new dependency; the foreign-conversation 404 is a named case.)
- [x] Review threads resolved; charter §9 decisions recorded in the runbook.

## 10. Close-out

**AC-1 — the detail view shows each AI message's citations with the exact
`article_version` body/quote that was used.** Met.

The pane shows, per AI message: `model_id`, `prompt_version`, `decision`,
`reason_code`, `confidence`, and for every citation the **quote** (the sentence the
model leaned on), the **cited version's body**, the article title and version
number, and a label when that version is no longer current. Guest messages render
as text.

**The one decision: 0022 adds `citations.quote`.** S05-03 read the contract's
`quote`, proved it appears in the cited version (`src/ai/guard.ts`), and then
dropped it, with a comment saying that if it were ever needed it belonged in a new
column. "Staff can see the cited text verbatim" is that need. Without the column
the pane can only show a 19,000-character noticeboard and ask an agent to find the
sentence while a guest waits.

```sql
ALTER TABLE citations ADD COLUMN quote text;
ALTER TABLE citations ADD CONSTRAINT citations_quote_shape
  CHECK (quote IS NULL OR length(btrim(quote)) BETWEEN 1 AND 400);
```

Nullable on purpose: every citation written before 0022 has no quote, and
inventing one would be falsifying history. Those rows fall back to the body, which
is exactly what S05-03 could offer. The `BETWEEN 1 AND 400` mirrors
`src/ai/contract.ts` so a row that could never have come out of the model is
refused by the table too.

`recordCitations` now takes `{articleVersionId, quote}` (a bare string still
works, for backfills), de-duplicated by version with the first non-empty quote
winning. `answerMessage` passes the contract's quotes through. Nothing else in the
write path changed.

**AC-2 — editing the article later does not change what staff see for an old
answer.** Met, and it is a property of the schema rather than of this screen:
`article_versions` are immutable (0003) and citations point at versions, not
articles (D5). The detail view is therefore not allowed to help it break — it
reads `article_versions.body` and never `knowledge_articles`. The test publishes
v2 and then v3 and re-reads: quote and body are byte-identical, `version_no` stays
1, and `isCurrent` flips to `false` (history being honest, not an error).

**Reuse, not a second join.** The charter said not to write a second citation
join. The join moved into `src/ai/history.ts::loadCitations`, parameterised over
`ai_run_id = ANY($3)`, and both `reconstructAnswer` (one run) and
`getConversationDetail` (a conversation's runs) call it. One test asserts the two
paths return the same quote, because the failure mode of a duplicate join is that
one of them starts lying about what was cited.

**Path correction.** The charter's §4 assumed `?conversation=`; the route is
**`GET /api/inbox/conversations/:id`** — it is a resource, the list already lives
at `/api/inbox`, and a query parameter on a collection would have meant two shapes
of the same handler. A malformed or foreign or unknown id is **404 with an
identical body**: existence is not something this route confirms. Auth is the
shared `handleStaffRequest` pipeline (`queue: read`), and there is no write on this
screen, so `observer` reads (same deviation as S08-01, same reason).

**Escaping.** The API returns guest text raw — escaping in the service would
corrupt the transcript for every other consumer and double-escape on the next hop.
The page renders every body as a JSX text child; `tests/inbox/detail-page.test.ts`
reads the source and fails if `dangerouslySetInnerHTML` (or `innerHTML`) appears in
it, because that one edit is how this screen becomes stored XSS. Stripping comments
first matters: the page's own prose explains why the API is not used.

**`data-ai-run-id`** is on every AI message block, as §4 asked, so S09-03's
one-click "wrong or outdated" flag needs no markup archaeology.

**Not done, by scope:** flagging persistence (S09-03), reply/takeover (S08-03),
and no polling — the transcript is a snapshot, like the inbox list.

**Evidence:**

- `npm run db:migrate` — **22 applied** (0022).
- `npm run db:test` — **30 files / 261 passed** (8 new cases in
  `tests/db/inbox-detail.db.test.ts`).
- `npx vitest run` — **40 files / 518 passed** (4 new cases in
  `tests/inbox/detail-page.test.ts`).
- `npx tsc --noEmit` and `npm run lint` clean, root and `web/`.
- `npm run web:build` green; `/inbox/[conversationId]` in the manifest.
- Owed, and not faked: the §7 screenshot of the sources pane. It needs a signed-in
  staff session against a seeded tenant, which is an operator artifact like
  S08-01's phone stopwatch — the procedure is in the runbook, and
  `tests/db/inbox-detail.db.test.ts` is what actually proves the pane's data.
