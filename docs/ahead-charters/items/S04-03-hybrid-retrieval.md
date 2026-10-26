---
id: S04-03
title: Hybrid retrieval
sprint: S04
epic: S04 - Retrieval and review
track: Eng
estimate_days: 2.0
priority: P0
depends_on: [S04-02]
labels: [sprint:S04, track:foundation, prio:P0]
milestone: S04 - Retrieval and review
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/72
pickup: decision
approved: 2026-10-25
done: 2026-10-25
---

# S04-03 — Hybrid retrieval

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S04 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S04-02 |
| Pickup | `decision` |

## 1. Why / goal

Combine lexical + trigram + vector signals and prove recall ≥90% on the golden set.

## 2. Acceptance criteria (backlog AC verbatim)

> Recall ≥90% on the golden set's target articles.

- **AC-1** `retrieveCurrentVersions` keeps `AND is_current` in every SQL branch — no caller flag can include retired history.
- **AC-2** Property content overrides brand content on the same `topic_key`; brand fills gaps.
- **AC-3** recall@8 ≥90% on `target_topic` for the golden set.

## 3. Scope

**In:** Hybrid rank fusion, brand/property resolution, fact short-circuit, evaluation script, indexes.

**Out:** The 40-question golden set v2 itself (hotel-supplied, G1); LLM generation (S05-01).

## 4. Calculated changes (for the coding agent)

- `src/knowledge/retrieval.ts` already has `LEXICAL_SQL` (`ts_rank` over `article_versions.tsv`) and `VECTOR_SQL` (cosine). Add `src/knowledge/hybrid.ts`: three candidate queries over `article_chunks` (FTS `websearch_to_tsquery('simple',$1)`, trigram `similarity(body,$1)`, vector `<=>`), fused with RRF `score = Σ w_i / (60 + rank_i)` and explicit weights from `src/settings/schema.ts` (add `retrieval_weights` to `DEFAULT_SETTINGS`), then joined back to `article_versions` with `AND av.is_current`.
- Extend `RetrievalInput` with `mode?: 'lexical'|'vector'|'hybrid'` (default `hybrid`) and `scope?: 'auto'|'brand'|'property'`; **do not** add an `includeRetired` option. `is_current` stays a literal in all three statements — keep the S02-05 contract test that greps for it.
- `src/knowledge/resolve.ts`: `resolveTopic(context, topicKey, hits)` — property-scoped hits win over brand-scoped hits for the same `topic_key` (`knowledge_articles.scope ∈ {brand, property}` in 0001).
- **Fact short-circuit:** `src/knowledge/facts.ts::lookupFact` (PR #32) is called for structured keys first; a verified hit returns `{value, unit, effectiveFrom}` and bypasses generation. Expected contract only — see §8.
- Migration `0012_retrieval_indexes.sql`: `CREATE INDEX article_chunks_tsv ON article_chunks USING gin(tsv)`, `... USING hnsw (embedding vector_cosine_ops)`, `... USING gin (body gin_trgm_ops)`; plus `article_versions (property_id, is_current) WHERE is_current`.
- `scripts/eval-retrieval.ts`: read `data/golden/golden-questions-v2.csv` through `src/golden/validate.ts`, run each question, compute recall@8 against `target_topic`, print a per-question miss table and fail under 90%. `package.json` script `"eval:retrieval"`.

## 5. Tenancy & security

Every candidate query carries `org_id = $1 AND property_id = $2` (or the RLS-enforced equivalents); brand rows must still be scoped to the same org. Add a two-property test where each has a same-topic article.

## 6. Test plan (named cases)

- `tests/db/retrieval.db.test.ts` (extend): hybrid beats lexical on the Spanish-vs-English pool question; property overrides brand; stale chunk excluded; cross-tenant hit impossible.
- `tests/knowledge/hybrid.test.ts`: RRF ordering with a fixed candidate list.
- `tests/golden/validate.test.ts` (exists) for the v2 CSV shape.

## 6b. Tests as delivered

- `tests/db/retrieval.db.test.ts` — rewritten: every S02-05 assertion names its mode; the grep contract now covers `retrieval.ts` **and** `hybrid.ts` and requires five literal `av.is_current` predicates, no `includeRetired`, and no parameterised/boolean `is_current`.
- `tests/db/hybrid.db.test.ts` — 10 cases: whole body + `matchedChunk`, fused ordering, typo via trigram and a zero weight disabling it, vector-only branch from an embedding, property over brand (both scoped), shadowing when the property's chunk does not score, retired chunks unreachable after v2, input validation, `resolve.ts` unit behaviour.
- `tests/db/answer-source.db.test.ts` — 4 cases: fact answers before retrieval, fallback when no fact covers the key, wrong language does not cross-answer, not-yet-effective fact ignored.

## 7. Evidence to record in the runbook

- ``npm run eval:retrieval` (recall %, misses)`
- ``npm run db:test``
- `CI `test` job`

## 8. Pickup status, blockers and decisions

**DELIVERED 2026-10-25 for AC-1 and AC-2; AC-3 is not proven and is not claimed** (it needs golden set v2, G1). Evidence and the reasoning behind every choice below are in `docs/runbook.md` § S04-03.

Decisions taken during delivery:

- **`retrieval_weights` is a REQUIRED settings key** (0013), not an optional one: `{lexical, vector, trigram}` defaulting to `1/1/1`. Optional would make "nobody chose" indistinguishable from "the operator chose the default", and a property could then be ranked differently than the operator saw. 0013 backfills existing non-`{}` settings, then re-binds the CHECK to a new validator — a rename-only upgrade cannot work, because a CHECK constraint binds the function OID it was parsed against.
- **`rrf_k = 60` is a code constant, not a setting.** It changes every ranking and no hotel can reason about it; the tunable part is the three weights.
- **`0012` was reduced to one index**, `article_versions (property_id) WHERE is_current`: 0011 already created the `tsv`, trigram and HNSW indexes on `article_chunks`, so recreating them would have been duplication wearing a different id.
- **Brand/property coverage is content, not ranking** (`propertyCoveredTopics`): brand text is shadowed for a topic the property has published on even when the property's own chunk does not score. The alternative answers generic brand prose over a local correction.
- **`hybrid` is the default mode**, so the eight S02-05 auto-detect assertions name their mode explicitly (`mode: "lexical"` / `"vector"`) and the hybrid behaviour is pinned in `tests/db/hybrid.db.test.ts` instead.
- **`reembedAndPublish` now shares `writeChunks`**: it used to publish a version with zero chunks, which was invisible until retrieval started reading chunks and would have falsified S04-02's AC-1 on that route.

Open blockers:

- **G1 content dependency.** The engine is fully calculable now, but the **exit criterion cannot be proven** until the hotel supplies ≥25 approved articles and golden set v2 (≥40 questions). The gate says 'delay the pilot, not the build' — build now, prove at G1.
- **Prerequisite cleared.** `lookupFact` landed in S03-03 with the signature this item assumed; the short-circuit is `src/knowledge/answer.ts::resolveAnswerSource`, which consults a verified fact before it ever ranks an article.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
