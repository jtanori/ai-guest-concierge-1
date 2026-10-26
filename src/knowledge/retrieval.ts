/**
 * S02-05 - the retrieval primitive.
 *
 * `is_current` is a literal in BOTH statements, not an option: there is no
 * caller flag, mode or setting that can include retired history. S05's answer
 * pipeline must call this function (never raw SQL) so the guarantee cannot be
 * lost by a future query.
 *
 * The caller supplies the tenant transaction (`withTenant` / a staff session);
 * RLS scopes the rows to org + property.
 *
 * S04-03 adds `mode`. The default is `hybrid` — reciprocal-rank fusion over the
 * chunk layer (hybrid.ts) — because that is what the answer pipeline should
 * use. `lexical` and `vector` keep the S02-05 whole-body statements exactly as
 * they were, for callers that want one signal and for the tests that pin that
 * behaviour. `is_current` is a literal in all five statements (the two here,
 * the three in hybrid.ts); no option can widen it.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import { assertEmbeddingDimension, toVectorLiteral } from "./embedding.ts";
import { hybridRetrieve } from "./hybrid.ts";
import { preferProperty, propertyCoveredTopics } from "./resolve.ts";
import { DEFAULT_SETTINGS, type RetrievalWeights } from "../settings/schema.ts";

export const RETRIEVAL_MODES = ["lexical", "vector", "hybrid"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export const RETRIEVAL_SCOPES = ["auto", "brand", "property"] as const;
export type RetrievalScope = (typeof RETRIEVAL_SCOPES)[number];

export interface RetrievalInput {
  text: string;
  embedding?: number[];
  limit?: number;
  /** Default `hybrid`. */
  mode?: RetrievalMode;
  /**
   * `auto` (default) ranks brand and property content together and then lets
   * the property's text shadow brand text for the same topic; `brand` and
   * `property` restrict the candidates outright.
   */
  scope?: RetrievalScope;
  /** Fusion weights; defaults to the property contract's defaults. */
  weights?: RetrievalWeights;
}

export interface RetrievalHit {
  articleVersionId: string;
  articleId: string;
  topicKey: string;
  title: string;
  body: string;
  language: string | null;
  versionNo: number;
  score: number;
  scope: "brand" | "property";
  /** Present on hybrid hits: the chunk that earned the score, for citation. */
  matchedChunk?: { chunkId: string; ordinal: number; body: string };
  /** Present on hybrid hits: which of the three lists ranked it. */
  branches?: string[];
}

interface RetrievalRow {
  article_version_id: string;
  article_id: string;
  topic_key: string;
  title: string;
  body: string;
  language: string | null;
  version_no: number;
  scope: "brand" | "property";
  score: number;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

const LEXICAL_SQL = `
  WITH q AS (
    SELECT websearch_to_tsquery('simple', $1) AS tsquery
  )
  SELECT av.article_version_id,
         av.article_id,
         ka.topic_key,
         ka.title,
         av.body,
         ka.language,
         ka.scope,
         av.version_no,
         ts_rank(av.tsv, q.tsquery) AS score
    FROM article_versions av
    JOIN knowledge_articles ka
      ON ka.article_id = av.article_id
     AND ka.org_id = av.org_id
     AND ka.property_id = av.property_id
    CROSS JOIN q
   WHERE av.body IS NOT NULL
     AND av.is_current
     AND av.tsv @@ q.tsquery
   ORDER BY score DESC, av.article_version_id
   LIMIT $2
`;

const VECTOR_SQL = `
  SELECT av.article_version_id,
         av.article_id,
         ka.topic_key,
         ka.title,
         av.body,
         ka.language,
         ka.scope,
         av.version_no,
         1 - (av.embedding <=> $1::vector) AS score
    FROM article_versions av
    JOIN knowledge_articles ka
      ON ka.article_id = av.article_id
     AND ka.org_id = av.org_id
     AND ka.property_id = av.property_id
   WHERE av.body IS NOT NULL
     AND av.is_current
     AND av.embedding IS NOT NULL
   ORDER BY av.embedding <=> $1::vector, av.article_version_id
   LIMIT $2
`;

export async function retrieveCurrentVersions(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: RetrievalInput,
): Promise<RetrievalHit[]> {
  assertTenantShape(context);

  const mode: RetrievalMode = input.mode ?? "hybrid";
  if (!RETRIEVAL_MODES.includes(mode)) {
    throw new RangeError(`mode must be ${RETRIEVAL_MODES.join(" | ")}, got ${String(mode)}`);
  }
  const scope: RetrievalScope = input.scope ?? "auto";
  if (!RETRIEVAL_SCOPES.includes(scope)) {
    throw new RangeError(`scope must be ${RETRIEVAL_SCOPES.join(" | ")}, got ${String(scope)}`);
  }
  const limit = clampLimit(input.limit);

  if (mode === "hybrid") {
    const hits = await hybridRetrieve(client, context, {
      text: input.text,
      embedding: input.embedding,
      limit,
      scope,
      weights: input.weights ?? DEFAULT_SETTINGS.retrieval_weights,
    });
    // `auto` also applies the brand/property rule after fusion; an explicit
    // scope has already been enforced in SQL. Coverage comes from the database,
    // not from the list: the property's own article may not have scored at all.
    if (scope !== "auto") return hits;
    return preferProperty(hits, await propertyCoveredTopics(client, context));
  }

  let rows: RetrievalRow[];
  if (mode === "vector") {
    if (input.embedding === undefined) {
      throw new RangeError("mode 'vector' needs an embedding");
    }
    assertEmbeddingDimension(input.embedding);
    const result = await client.query<RetrievalRow>(VECTOR_SQL, [
      toVectorLiteral(input.embedding),
      limit,
    ]);
    rows = result.rows;
  } else {
    // Lexical ignores a supplied embedding on purpose: mode is the contract,
    // and a caller that says "lexical" gets the statement it asked for.
    const result = await client.query<RetrievalRow>(LEXICAL_SQL, [input.text, limit]);
    rows = result.rows;
  }

  const hits = rows.map((row) => ({
    articleVersionId: row.article_version_id,
    articleId: row.article_id,
    topicKey: row.topic_key,
    title: row.title,
    body: row.body,
    language: row.language,
    versionNo: row.version_no,
    score: Number(row.score),
    scope: row.scope,
  }));

  if (scope !== "auto") return hits.filter((hit) => hit.scope === scope);
  return preferProperty(hits, await propertyCoveredTopics(client, context));
}
