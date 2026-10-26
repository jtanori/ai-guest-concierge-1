/**
 * S04-03 — reciprocal-rank fusion over the chunk layer.
 *
 * WHY THREE LISTS, AND WHY FUSION RATHER THAN ONE RANKING: the three signals do
 * not fail in the same places. Lexical (tsvector) is exact but brittle to
 * Spanish inflection — "cerrar" does not match "cierra". Trigram survives
 * typos and accents. Vector survives paraphrase and language mixing. A single
 * ranking would have to choose which of those to lose; RRF keeps all three and
 * only asks how much each one is worth, which is the `retrieval_weights`
 * setting (0013).
 *
 * WHY RRF AND NOT SCORE SUMMATION: the three branches return numbers on
 * incomparable scales — `ts_rank` is a small float tuned per document,
 * `similarity` is 0..1, cosine distance is 0..2. Summing them would let
 * whichever branch happens to produce bigger numbers dominate. RRF throws the
 * magnitudes away and keeps only the ORDER: `Σ w_i / (60 + rank_i)`. The 60 is
 * the standard RRF damping constant and stays a constant here on purpose: it
 * is not something a hotel can meaningfully tune, whereas relative trust in
 * the three signals is.
 *
 * WHY CHUNKS: a 3,000-word noticeboard answered by one whole-body vector
 * dilutes against every paragraph (S04-02's header). Candidates are chunks; the
 * version a chunk belongs to is what a guest's question is actually answered
 * from, so the fused score of a version is the score of its BEST chunk, and
 * that chunk travels with the hit (`matchedChunk`) for S05 to quote.
 *
 * `is_current` IS A LITERAL IN ALL THREE STATEMENTS (AC-1). There is no
 * parameter, mode or option that can include retired history — the same rule
 * S02-05 established for the whole-body path. `tests/db/hybrid.db.test.ts`
 * proves it by publishing a second version and searching for text that exists
 * only in the first.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import {
  DEFAULT_SETTINGS,
  type RetrievalWeights,
} from "../settings/schema.ts";
import { assertEmbeddingDimension, toVectorLiteral } from "./embedding.ts";
import type { RetrievalHit, RetrievalScope } from "./retrieval.ts";

/** The standard RRF damping constant. Not a setting: it changes every ranking. */
export const RRF_K = 60;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
/** Per-branch candidate count before fusion. Deeper than the final limit so a
 *  branch that disagrees with the others can still contribute. */
const DEFAULT_CANDIDATES = 30;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

export interface HybridInput {
  text: string;
  /** Supplying it enables the vector branch; omitting it fuses the other two. */
  embedding?: number[];
  limit?: number;
  weights?: RetrievalWeights;
  scope?: RetrievalScope;
  /** Rows fetched per branch before fusion. */
  candidates?: number;
}

interface ChunkCandidate {
  chunk_id: string;
  article_version_id: string;
  ordinal: number;
  chunk_body: string;
  article_id: string;
  topic_key: string;
  title: string;
  language: string | null;
  version_no: number;
  body: string;
  scope: "brand" | "property";
  score: number;
}

const CANDIDATE_COLUMNS = `
         c.chunk_id,
         c.article_version_id,
         c.ordinal,
         c.body AS chunk_body,
         av.article_id,
         av.body,
         av.version_no,
         ka.topic_key,
         ka.title,
         ka.language,
         ka.scope`;

const CANDIDATE_JOINS = `
    FROM article_chunks c
    JOIN article_versions av
      ON av.article_version_id = c.article_version_id
     AND av.org_id = c.org_id
     AND av.property_id = c.property_id
    JOIN knowledge_articles ka
      ON ka.article_id = av.article_id
     AND ka.org_id = av.org_id
     AND ka.property_id = av.property_id`;

const SCOPE_PREDICATE = `
     AND ($3 = 'auto' OR ka.scope = $3)`;

/**
 * Lexical: every token OR-ed together, ranked by `ts_rank`.
 *
 * `websearch_to_tsquery` ANDs the terms, which is right for a search box and
 * wrong here: a chunk is one or two paragraphs, so "alberca cierra" requires
 * both words in the SAME chunk — "La alberca abre a las 07:00..." plus "cierra
 * a las 21:00" elsewhere in the article scores zero. The article is a unit and
 * the chunk is a slice of it, so the branch asks "which tokens appear here",
 * and `ts_rank` decides how good the match is. Precision is the fusion's job:
 * a chunk that matches one common token ranks low against ones that match
 * several, and the other two branches contribute their own order.
 *
 * Tokens are quoted, not interpolated: `to_tsquery` treats `&`, `|`, `!` and
 * `:` as operators, and a guest's question is not a query language.
 */
const LEXICAL_CHUNK_SQL = `
  WITH q AS MATERIALIZED (
    SELECT to_tsquery(
             'simple',
             (SELECT string_agg(quote_literal(token), ' | ')
                FROM unnest(tsvector_to_array(to_tsvector('simple', $1))) AS token)
           ) AS tsquery
  )
  SELECT ${CANDIDATE_COLUMNS},
         ts_rank(c.tsv, q.tsquery) AS score
${CANDIDATE_JOINS}
    CROSS JOIN q
   WHERE av.is_current
     AND av.body IS NOT NULL
     AND q.tsquery IS NOT NULL
     AND c.tsv @@ q.tsquery${SCOPE_PREDICATE}
   ORDER BY score DESC, c.chunk_id
   LIMIT $2
`;

/**
 * Trigram: the typo/accent-tolerant branch.
 *
 * It compares each QUERY TOKEN against the chunk and keeps the best per-token
 * score, rather than comparing the whole query string to the whole chunk. Two
 * reasons, both measured on the fixture corpus:
 *
 *  - Whole-string `similarity` is the wrong question. A real chunk is 200-400
 *    characters, so even a perfect single-word match scores ~0.10, and a long
 *    chunk can never win: "albcrca" scores 0.10 against a chunk containing
 *    "alberca".
 *  - `word_similarity(query, body)` fixes that only for a ONE-word query: with
 *    "alberca cierra" it wants those two words adjacent and returns ~0, so
 *    every real question would silently skip this branch.
 *
 * Taking `max(word_similarity(token, body))` asks the question that matters —
 * "does some word in here look like something the guest typed?" — and it is
 * what makes a misspelling survive when the exact term is absent.
 *
 * The threshold is explicit rather than pg_trgm's `%` operator, which gates on
 * a GUC (0.3 default). 0.4 sits clear of both sides measured against the
 * fixture corpus: unrelated prose scores <= 0.25 for a foreign-language
 * question, a one-letter typo in a known term scores >= 0.45. The honest cost:
 * an explicit threshold cannot use the GIN trigram index, so this branch scans
 * the property's chunks — cheaper at pilot volume than a branch that silently
 * returns nothing.
 */
const TRIGRAM_CHUNK_SQL = `
  SELECT ${CANDIDATE_COLUMNS},
         s.score
${CANDIDATE_JOINS}
    CROSS JOIN LATERAL (
      SELECT max(word_similarity(token, c.body)) AS score
        FROM unnest(tsvector_to_array(to_tsvector('simple', $1))) AS token
    ) AS s
   WHERE av.is_current
     AND av.body IS NOT NULL
     AND s.score >= 0.4${SCOPE_PREDICATE}
   ORDER BY s.score DESC, c.chunk_id
   LIMIT $2
`;

const VECTOR_CHUNK_SQL = `
  SELECT ${CANDIDATE_COLUMNS},
         1 - (c.embedding <=> $1::vector) AS score
${CANDIDATE_JOINS}
   WHERE av.is_current
     AND av.body IS NOT NULL
     AND c.embedding IS NOT NULL
     AND ($2 = 'auto' OR ka.scope = $2)
   ORDER BY c.embedding <=> $1::vector, c.chunk_id
   LIMIT $3
`;

interface Fused {
  candidate: ChunkCandidate;
  score: number;
  /** Which branches contributed, for the eval script's miss table. */
  branches: string[];
}

function fuse(
  branches: Array<{ name: string; weight: number; rows: ChunkCandidate[] }>,
): Fused[] {
  const byChunk = new Map<string, Fused>();

  for (const branch of branches) {
    // A weight of 0 disables a branch entirely rather than ranking it last.
    if (branch.weight <= 0) continue;
    branch.rows.forEach((candidate, index) => {
      const contribution = branch.weight / (RRF_K + index + 1);
      const existing = byChunk.get(candidate.chunk_id);
      if (existing === undefined) {
        byChunk.set(candidate.chunk_id, {
          candidate,
          score: contribution,
          branches: [branch.name],
        });
        return;
      }
      existing.score += contribution;
      existing.branches.push(branch.name);
    });
  }

  return [...byChunk.values()];
}

/**
 * Collapses chunk candidates to one hit per article version, keeping the
 * best-scoring chunk. A version whose paragraphs are individually relevant
 * should not out-rank a version with one perfect match just by having more
 * paragraphs.
 */
function toHits(fused: Fused[], limit: number): RetrievalHit[] {
  const bestPerVersion = new Map<string, Fused>();
  for (const entry of fused) {
    const key = entry.candidate.article_version_id;
    const current = bestPerVersion.get(key);
    if (current === undefined || entry.score > current.score) {
      bestPerVersion.set(key, entry);
    }
  }

  return [...bestPerVersion.values()]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      // Deterministic tie-break: ids are stable, scores are floats.
      return left.candidate.article_version_id.localeCompare(right.candidate.article_version_id);
    })
    .slice(0, limit)
    .map((entry) => ({
      articleVersionId: entry.candidate.article_version_id,
      articleId: entry.candidate.article_id,
      topicKey: entry.candidate.topic_key,
      title: entry.candidate.title,
      body: entry.candidate.body,
      language: entry.candidate.language,
      versionNo: entry.candidate.version_no,
      score: entry.score,
      scope: entry.candidate.scope,
      matchedChunk: {
        chunkId: entry.candidate.chunk_id,
        ordinal: entry.candidate.ordinal,
        body: entry.candidate.chunk_body,
      },
      branches: entry.branches,
    }));
}

export async function hybridRetrieve(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: HybridInput,
): Promise<RetrievalHit[]> {
  assertTenantShape(context);

  const text = typeof input.text === "string" ? input.text.trim() : "";
  // An embedding-only call is legitimate (S02-05's vector path), but two empty
  // inputs would fuse three empty lists and return nothing for no stated reason.
  if (text === "" && input.embedding === undefined) {
    throw new RangeError("hybrid retrieval needs a question or an embedding");
  }

  const limit = clampLimit(input.limit);
  const candidates = Math.max(
    limit,
    Math.min(MAX_LIMIT * 2, Math.trunc(input.candidates ?? DEFAULT_CANDIDATES)),
  );
  const weights = input.weights ?? DEFAULT_SETTINGS.retrieval_weights;
  const scope: RetrievalScope = input.scope ?? "auto";
  if (scope !== "auto" && scope !== "brand" && scope !== "property") {
    throw new RangeError(`scope must be auto | brand | property, got ${String(scope)}`);
  }

  const lexical =
    text === ""
      ? { rows: [] as ChunkCandidate[] }
      : await client.query<ChunkCandidate>(LEXICAL_CHUNK_SQL, [text, candidates, scope]);
  const trigram =
    text === ""
      ? { rows: [] as ChunkCandidate[] }
      : await client.query<ChunkCandidate>(TRIGRAM_CHUNK_SQL, [text, candidates, scope]);

  let vector: ChunkCandidate[] = [];
  if (input.embedding !== undefined) {
    assertEmbeddingDimension(input.embedding);
    const result = await client.query<ChunkCandidate>(VECTOR_CHUNK_SQL, [
      toVectorLiteral(input.embedding),
      scope,
      candidates,
    ]);
    vector = result.rows;
  }

  const fused = fuse(
    [
      { name: "lexical", weight: weights.lexical, rows: lexical.rows },
      { name: "trigram", weight: weights.trigram, rows: trigram.rows },
      { name: "vector", weight: weights.vector, rows: vector },
    ],
  );

  return toHits(fused, limit);
}
