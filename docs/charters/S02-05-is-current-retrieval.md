---
id: S02-05
title: is_current retrieval filtering + re-embed job
sprint: S02
epic: S02 — Identity, settings, audit
track: Knowledge
estimate_days: 0.5
priority: P0
depends_on: [S02-04]
labels: [sprint:S02, track:foundation, prio:P0]
milestone: S02 — Identity, settings, audit
---

# S02-05 — is_current retrieval filtering + re-embed job

## 1. Why

The backlog AC is "Editing an article makes its old chunks unretrievable". The
plan (§3 "Embedding integrity") calls this the most damaging failure the
product can have: an immutable version history means an edited article's old
text is still in the table, and without a hard filter the concierge quotes a
policy the hotel deleted — the hotel's own assistant becomes the source of the
error. The schema already enforces the write half (0003: versions born
retired, `is_current` moves only through `promote_article_version()`, which
refuses an unembedded version). The read half and the embed-then-publish job
do not exist yet.

## 2. Goal

A retrieval primitive that cannot return a retired version (hard filter at
query time, not only at write time), and a re-embed job that computes the
embedding for a new version and promotes it atomically — so "publish" is one
call and a half-swapped state is impossible. Both are the primitives S05/S06
build on; neither is wired into a guest path yet.

## 3. Acceptance criteria

**Backlog AC (verbatim):** Editing an article makes its old chunks unretrievable.

- **AC-1** After a new version is embedded and promoted, a retrieval query
  that matches text unique to the old version returns zero rows; a query
  matching the new version returns only the new version.
- **AC-2** The `is_current = true` filter is unconditional in the retrieval
  SQL — no caller flag, mode or option can disable it. Vector and lexical
  paths both filter.
- **AC-3** History stays intact: the retired version is still selectable by
  `article_version_id` (citations in historical `ai_runs` keep resolving); only
  retrieval stops seeing it.
- **AC-4** `reembedAndPublish` refuses: a version from another tenant, an
  unknown id, a null body (the fixture noticeboard), an already-current
  version, and an embedding of the wrong dimension. Refusals are typed errors.
- **AC-5** Embedding + promotion happen in one transaction: if promotion
  fails, the embedding write rolls back too (no half-published version).
- **AC-6** The job never rewrites history: body/title/version_no are untouched
  (0003 trigger remains the enforcement).

## 4. Scope

**In:** `src/knowledge/retrieval.ts` (`retrieveCurrentVersions`);
`src/knowledge/reembed.ts` (`reembedAndPublish`, `Embedder` port, typed
errors); `tests/db/retrieval.db.test.ts`; unit tests for the embedding
validator.

**Out:** chunking (this schema retrieves `article_versions` rows — see §5.1);
hybrid ranking/RRF, prompt construction, "I don't know" logic (S05/S06);
nightly reconciliation with the three invariants (S11-05, which reuses these
primitives); fact retrieval (`property_facts` has no `is_current`; S03-03 owns
its version semantics); real provider embedding calls (S05 supplies the
`Embedder` implementation).

## 5. Design

### 5.1 What "chunks" means in this schema

There is no chunk table: `article_versions` carries `embedding vector(1536)`,
`tsv` and the `is_current` marker, and 0003 already requires the embedding
before promotion. The plan's "chunks" language maps to one embedding per
version here. Do not introduce a chunk table in this item; if real chunking
arrives later it is a schema change with its own item.

### 5.2 Retrieval (`src/knowledge/retrieval.ts`)

```ts
export interface RetrievalInput {
  text: string;                 // guest question (lexical path)
  embedding?: number[];         // when present, vector path
  limit?: number;               // default 8, clamped 1..50
}
export interface RetrievalHit {
  articleVersionId: string; articleId: string; topicKey: string;
  title: string; body: string; language: string | null;
  versionNo: number; score: number;
}
export async function retrieveCurrentVersions(
  client: pg.Client, ctx: { orgId: string; propertyId: string }, input: RetrievalInput,
): Promise<RetrievalHit[]>;
```

- SQL always contains `AND av.is_current` (literal in the statement, not
  interpolated) plus the RLS tenant context; `body IS NOT NULL` is implied by
  promotion but kept for safety.
- Lexical: `tsv @@ websearch_to_tsquery('simple', $text)`, ordered by
  `ts_rank(tsv, query)`.
- Vector: ordered by `embedding <=> $vec` with `embedding IS NOT NULL`.
  Combining lexical + vector (RRF) is S05's call — this primitive exposes one
  mode at a time so the filter is provable in isolation.
- Returns rows only; no generation, no citations, no side effects.

### 5.3 Re-embed job (`src/knowledge/reembed.ts`)

```ts
export type Embedder = (text: string) => Promise<number[]>;
export class VersionNotFoundError extends Error {}
export class UnembeddableVersionError extends Error {}   // body IS NULL
export class VersionAlreadyCurrentError extends Error {}
export class EmbeddingDimensionError extends Error {}    // != 1536 or non-finite
export async function reembedAndPublish(
  client: pg.Client, ctx: { orgId: string; propertyId: string },
  articleVersionId: string, embed: Embedder,
): Promise<{ articleVersionId: string; versionNo: number }>;
```

Steps (caller supplies an open transaction; the CLI/job owns BEGIN/COMMIT):
1. `SELECT article_id, version_no, body, is_current, promoted_at` by id under
   the tenant GUCs (RLS scopes it; a foreign id is simply not found).
2. Refuse: not found; `is_current` true (nothing to do — avoids spend);
   `body IS NULL`.
3. `const vector = await embed(body)`; validate `length === 1536`, all finite.
4. `UPDATE article_versions SET embedding = $1 WHERE article_version_id = $2`
   — 0003 allows embedding-only backfill; any other column would raise.
5. `SELECT promote_article_version($1)` — demote old + raise new in the same
   transaction; the function re-checks tenant context, embedding non-null and
   the one-way history rule.

Return the version identity for logging. No retry/queue in this item: the job
runner (S05/S07) retries; this function is idempotent at the transaction
level (a failed promotion leaves no embedding behind).

### 5.4 Wiring rule

Nothing in the guest path calls these yet. When S05 builds the answer
pipeline it must call `retrieveCurrentVersions` (never raw SQL) and use
`reembedAndPublish` for publish; the review checklist asks for it. This item's
job is to make that the only sensible option.

## 6. Tenancy and security

- Both functions require the tenant GUCs (`withTenant` / `withStaffSession`);
  RLS scopes selects and updates; promotion re-checks org/property inside the
  definer function (0003).
- A foreign-tenant version id is indistinguishable from an unknown id — no
  existence leak.
- Embeddings are derived from article bodies; no guest data is involved.
- No new grants; `concierge_app` already has SELECT/UPDATE on
  `article_versions` and EXECUTE on `promote_article_version`.

## 7. Test plan

Unit — `tests/knowledge/embedding.test.ts`:
- dimension validator accepts 1536 finite floats; rejects 1535, NaN,
  Infinity, non-array.

DB — `tests/db/retrieval.db.test.ts`:
- seed a minimal tenant (helpers): article + v1 (`body` contains
  `UNIQUE_OLD_TOKEN`) with `stubEmbedding`, promoted; lexical retrieval for
  the token returns v1.
- insert v2 (`UNIQUE_NEW_TOKEN`), `reembedAndPublish`; lexical query for
  `UNIQUE_OLD_TOKEN` → 0 rows; for `UNIQUE_NEW_TOKEN` → v2 only; v1 still
  selectable by id and its body unchanged (AC-3).
- vector path: query with v1's embedding → v1 excluded, v2 present (proves
  the filter is on both paths).
- a retired version whose text is the strongest lexical match is never
  returned (the AC's literal failure mode).
- refusals: unknown id; property-B context on a property-A id; null body;
  already-current; wrong dimension (assert no embedding was written).
- atomicity: promotion failure (e.g. pass an id whose version is retired
  history) → embedding update rolled back (`embedding` still NULL).
- `is_current` filter cannot be bypassed: the exported function has no option
  to include retired rows (type-level assertion + SQL snapshot assertion in
  the test file).

## 8. Evidence

```text
$ npm run db:test          # retrieval suite green; existing suites unchanged
$ npm test                 # embedding validator unit tests
$ npm run typecheck && npm run lint && npm run build
```

Runbook S02-05 entry states the AC test names (old token unretrievable, vector
path filtered, history intact) and the counts.

## 9. Risks and open questions

- **Real embeddings**: `Embedder` is a port; tests use `stubEmbedding`
  (S02-04, dev-only). Seeded vectors are non-semantic until S05 wires the
  provider; do not judge retrieval quality before then.
- **Hybrid ranking** (lexical + vector fusion) is deliberately not decided
  here; S05 owns it. Keeping single-mode retrieval makes the `is_current`
  guarantee testable now.
- **Chunking**: one embedding per version is the schema's model. If S05 wants
  smaller chunks, that is a schema migration plus this filter applied to the
  new table — do not bolt it on here.
- **Job runner**: no queue/retry/backoff in this item; S05/S07 own transport
  resilience. `reembedAndPublish` is the unit of work those runners call.
- **Nightly reconciliation** (three invariants, S11-05) is not built here; its
  charter will reuse `retrieveCurrentVersions`-style queries.

## 10. Definition of done

- [ ] Retrieval primitive hard-filters `is_current` on both paths; tested.
- [ ] `reembedAndPublish` embed+promote atomic; refusals typed and tested.
- [ ] Old-version-unretrievable AC demonstrated end to end in the db suite.
- [ ] No new dependency; no schema change.
- [ ] Runbook entry with evidence; workbook tick after merge.
- [ ] Review threads resolved; wiring rule noted for S05.
