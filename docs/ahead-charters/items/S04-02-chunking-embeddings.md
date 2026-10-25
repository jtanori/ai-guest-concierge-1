---
id: S04-02
title: Chunking + embeddings
sprint: S04
epic: S04 - Retrieval and review
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S03-01]
labels: [sprint:S04, track:foundation, prio:P0]
milestone: S04 - Retrieval and review
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/71
pickup: decision
---

# S04-02 — Chunking + embeddings

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S04 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S03-01 |
| Pickup | `decision` |

## 1. Why / goal

Published versions must be embedded so hybrid retrieval and the `is_current` invariant both hold.

## 2. Acceptance criteria (backlog AC verbatim)

> Every published version is chunked and embedded.

- **AC-1** Every `is_current` article version has ≥1 chunk; every chunk resolves to a current version.
- **AC-2** A version with no body (picture-only noticeboard) is refused publication rather than silently indexed.

## 3. Scope

**In:** Chunk table, chunker, embed-then-publish transaction, provider adapter, seed/fixture embeddings.

**Out:** Ranking/hybrid fusion (S04-03); changing the 1536-dimension schema (D3 locks `vector(1536)`).

## 4. Calculated changes (for the coding agent)

- `src/knowledge/embedding.ts` already exports `EMBEDDING_DIMENSIONS=1536`, `assertEmbeddingDimension`, `toVectorLiteral`. Add `src/knowledge/chunk.ts`: `chunkBody(body: string, opts?: {maxChars: number; overlap: number}): string[]` — paragraph-aware, never cut mid-sentence, default 1200/150, and `assertChunkShape(chunks)` (non-empty, ≤2000 chars each, deterministic).
- Migration `0011_article_chunks.sql`: `article_chunks(org_id uuid, property_id uuid, chunk_id uuid PK, article_version_id uuid, ordinal int, body text NOT NULL, embedding vector(1536), tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED, UNIQUE (article_version_id, ordinal), composite FK (org_id,property_id,article_version_id) → article_versions ON DELETE CASCADE, FK (org_id,property_id) → properties)`; indexes `gin(tsv)`, `hnsw(embedding vector_cosine_ops)`, `gin(body gin_trgm_ops)`; ENABLE + FORCE RLS + `tenant` policy + grants (0002's `ALTER DEFAULT PRIVILEGES` was set for the migration role — verify with the `non-superuser.db.test.ts` job).
- **Extend** `src/knowledge/reembed.ts` (do not replace): add `chunkAndPublish(client, context, articleVersionId, embed: Embedder)` that chunks, embeds each chunk (batch call), inserts `article_chunks`, then calls `promote_article_version($1)` — all in the caller's transaction, so a failed promotion rolls back the chunks. Keep `reembedAndPublish` for the full-body embedding on `article_versions` that `retrieval.ts` uses today.
- `src/providers/embedding.ts`: `export interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]> }` + a `fetch`-based adapter reading `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` from `src/config/env.ts`; validate every returned vector with `assertEmbeddingDimension` before it reaches Postgres. No SDK dependency unless approved.
- `scripts/embed-all.ts` + extend `src/seed/embedding.ts` so `npm run db:seed` fills the fixture's 7 versions and the adversarial 3,000-word case.

## 5. Tenancy & security

`article_chunks` is a tenant table: add to the isolation suite's zero-row enumeration and the schema list. `chunkAndPublish` must keep `assertTenantShape(context)` and run as `concierge_app`.

## 6. Test plan (named cases)

- `tests/knowledge/chunking.test.ts`: 3,000-word article → multiple chunks with overlap; picture-only → 0 → `UnembeddableVersionError`; dimension/NaN rejection.
- `tests/db/chunks.db.test.ts`: every current version ≥1 chunk; no orphan chunk; rollback leaves no chunks; `is_current` filter still excludes retired versions (link to `tests/db/retrieval.db.test.ts`).

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``
- ``node --env-file=.env.local scripts/embed-all.ts` (counts per version)`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-3 (embedding provider + API key).** Schema fixes 1536 dims (D3), so the provider must emit 1536 (e.g. `text-embedding-3-small`). The service contract (`Embedder`/`EmbeddingProvider`) is fully calculated; only the concrete adapter + env vars wait on the decision.
- A real provider SDK would be a new runtime dependency — requires explicit approval per `docs/charters/README.md` §Approval checklist.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.

## Limited package authorization

See [parallel-work approval](../approvals/parallel-work.md). Only `S04-02-A` is owner-authorized, effective after the documentation PR merges. This parent charter remains draft and its full AC is unchanged.
