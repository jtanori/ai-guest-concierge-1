/**
 * S02-05 - the retrieval primitive.
 *
 * `is_current` is a literal in BOTH statements, not an option: there is no
 * caller flag, mode or setting that can include retired history. S05's answer
 * pipeline must call this function (never raw SQL) so the guarantee cannot be
 * lost by a future query.
 *
 * The caller supplies the tenant transaction (`withTenant` / a staff session);
 * RLS scopes the rows to org + property. One mode runs per call: lexical when
 * `embedding` is absent, vector when it is present. Hybrid ranking is S05's
 * decision and deliberately not baked in here.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import { assertEmbeddingDimension, toVectorLiteral } from "./embedding.ts";

export interface RetrievalInput {
  text: string;
  embedding?: number[];
  limit?: number;
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
}

interface RetrievalRow {
  article_version_id: string;
  article_id: string;
  topic_key: string;
  title: string;
  body: string;
  language: string | null;
  version_no: number;
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
  const limit = clampLimit(input.limit);

  let rows: RetrievalRow[];
  if (input.embedding !== undefined) {
    assertEmbeddingDimension(input.embedding);
    const result = await client.query<RetrievalRow>(VECTOR_SQL, [
      toVectorLiteral(input.embedding),
      limit,
    ]);
    rows = result.rows;
  } else {
    const result = await client.query<RetrievalRow>(LEXICAL_SQL, [input.text, limit]);
    rows = result.rows;
  }

  return rows.map((row) => ({
    articleVersionId: row.article_version_id,
    articleId: row.article_id,
    topicKey: row.topic_key,
    title: row.title,
    body: row.body,
    language: row.language,
    versionNo: row.version_no,
    score: Number(row.score),
  }));
}
