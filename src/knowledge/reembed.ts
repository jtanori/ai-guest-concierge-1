/**
 * S02-05 - embed-then-publish as one unit of work.
 *
 * The caller owns BEGIN/COMMIT (the S05/S07 job runner will retry around it).
 * This function only embeds and promotes: if promotion fails, the caller's
 * rollback removes the embedding write too, so a version is never left
 * half-published. It never rewrites body/title/version_no - 0003's trigger is
 * the enforcement.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import { assertChunkShape, chunkBody, type ChunkOptions } from "./chunk.ts";
import {
  assertEmbeddingDimension,
  EmbeddingDimensionError,
  toVectorLiteral,
} from "./embedding.ts";

export type Embedder = (text: string) => Promise<number[]>;

/** One provider call for many texts; `chunkAndPublish` batches through this. */
export type BatchEmbedder = (texts: readonly string[]) => Promise<number[][]>;

export { EmbeddingDimensionError } from "./embedding.ts";

export class VersionNotFoundError extends Error {
  constructor(articleVersionId: string) {
    super(
      `article_version ${articleVersionId} was not found in this tenant (or does not exist)`,
    );
    this.name = "VersionNotFoundError";
  }
}

export class UnembeddableVersionError extends Error {
  constructor(articleVersionId: string) {
    super(`article_version ${articleVersionId} has no body to embed`);
    this.name = "UnembeddableVersionError";
  }
}

export class VersionAlreadyCurrentError extends Error {
  constructor(articleVersionId: string) {
    super(`article_version ${articleVersionId} is already current`);
    this.name = "VersionAlreadyCurrentError";
  }
}

export class VersionNotCurrentError extends Error {
  constructor(articleVersionId: string) {
    super(
      `article_version ${articleVersionId} is not current; only a current version keeps chunks (S04-02 AC-1)`,
    );
    this.name = "VersionNotCurrentError";
  }
}

interface VersionRow {
  article_id: string;
  version_no: number;
  body: string | null;
  is_current: boolean;
  promoted_at: Date | null;
}

export async function reembedAndPublish(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleVersionId: string,
  embed: Embedder,
): Promise<{ articleVersionId: string; versionNo: number }> {
  assertTenantShape(context);

  const found = await client.query<VersionRow>(
    `SELECT article_id, version_no, body, is_current, promoted_at
       FROM article_versions
      WHERE article_version_id = $1`,
    [articleVersionId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new VersionNotFoundError(articleVersionId);
  if (row.is_current) throw new VersionAlreadyCurrentError(articleVersionId);
  if (row.body === null) throw new UnembeddableVersionError(articleVersionId);

  const vector = await embed(row.body);
  assertEmbeddingDimension(vector);

  const updated = await client.query(
    `UPDATE article_versions
        SET embedding = $1::vector
      WHERE article_version_id = $2`,
    [toVectorLiteral(vector), articleVersionId],
  );
  if (updated.rowCount !== 1) throw new VersionNotFoundError(articleVersionId);

  await client.query("SELECT promote_article_version($1)", [articleVersionId]);

  // S04-02's invariant, kept on THIS path too: only the current version of an
  // article keeps chunks. Publishing here (the whole-body route) must not
  // leave the retired version's chunks retrievable.
  await deleteRetiredChunks(client, context, row.article_id, articleVersionId);

  return { articleVersionId, versionNo: row.version_no };
}

/**
 * S04-02 — chunk, embed, then publish, as one unit of work.
 *
 * The caller owns BEGIN/COMMIT (a job runner will retry around it). Order is
 * the whole point:
 *
 *   read the version -> chunk -> embed EVERY chunk -> write chunks ->
 *   promote -> retire the previous version's chunks
 *
 * so a provider failure, a dimension mismatch or a refused promotion leaves
 * the version retired and the article's current chunks untouched. Nothing is
 * promoted before its chunks exist, which is the half of AC-1 a "publish then
 * backfill" design always gets wrong.
 */
export interface ChunkAndPublishResult {
  articleVersionId: string;
  versionNo: number;
  chunkCount: number;
}

export async function chunkAndPublish(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleVersionId: string,
  embed: BatchEmbedder,
  options: ChunkOptions = {},
): Promise<ChunkAndPublishResult> {
  assertTenantShape(context);

  const row = await readVersion(client, articleVersionId);
  if (row.is_current) throw new VersionAlreadyCurrentError(articleVersionId);
  // AC-2: a body-less noticeboard is refused, never silently indexed as
  // "nothing to retrieve". Same error as the whole-body path.
  assertHasBody(row.body, articleVersionId);

  const chunkCount = await writeChunks(client, context, articleVersionId, row.body!, embed, options);

  await client.query("SELECT promote_article_version($1)", [articleVersionId]);
  await deleteRetiredChunks(client, context, row.article_id, articleVersionId);

  return { articleVersionId, versionNo: row.version_no, chunkCount };
}

/**
 * Backfill for a version that is ALREADY current — the S04-02 rollout case,
 * where a database published articles before chunks existed. It refuses to
 * touch a retired version: only current versions keep chunks (AC-1), so
 * chunking history would immediately violate the invariant it is meant to
 * restore.
 */
export async function backfillChunks(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleVersionId: string,
  embed: BatchEmbedder,
  options: ChunkOptions = {},
): Promise<{ articleVersionId: string; chunkCount: number }> {
  assertTenantShape(context);

  const row = await readVersion(client, articleVersionId);
  if (!row.is_current) throw new VersionNotCurrentError(articleVersionId);
  assertHasBody(row.body, articleVersionId);

  const chunkCount = await writeChunks(client, context, articleVersionId, row.body!, embed, options);
  await deleteRetiredChunks(client, context, row.article_id, articleVersionId);
  return { articleVersionId, chunkCount };
}

async function readVersion(
  client: pg.Client | pg.PoolClient,
  articleVersionId: string,
): Promise<VersionRow> {
  const found = await client.query<VersionRow>(
    `SELECT article_id, version_no, body, is_current, promoted_at
       FROM article_versions
      WHERE article_version_id = $1`,
    [articleVersionId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new VersionNotFoundError(articleVersionId);
  return row;
}

function assertHasBody(body: string | null, articleVersionId: string): void {
  if (body === null || body.trim() === "") throw new UnembeddableVersionError(articleVersionId);
}

/**
 * The single insert path for chunks.
 *
 * ONE provider call embeds `[body, ...chunks]`, because `promote_article_version`
 * (0003) refuses a version whose own `embedding` column is still NULL — the
 * publish gate S02-05 installed. Chunk vectors alone therefore cannot satisfy
 * it, and paying for two round trips (one for the body, one for the chunks)
 * would be a self-inflicted race: the two vectors could come from providers
 * that disagree. Position 0 is the whole-body vector, positions 1..n are the
 * chunks, in ordinal order.
 *
 * The version must not be current yet, or this is a backfill and the DELETE
 * below is safe because a rollback restores the previous rows.
 */
async function writeChunks(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleVersionId: string,
  body: string,
  embed: BatchEmbedder,
  options: ChunkOptions,
): Promise<number> {
  const chunks = chunkBody(body, options);
  assertChunkShape(chunks);

  const vectors = await embed([body, ...chunks]);
  if (vectors.length !== chunks.length + 1) {
    throw new EmbeddingDimensionError(
      `provider returned ${vectors.length} vectors for ${chunks.length + 1} inputs (body + chunks)`,
    );
  }
  for (const vector of vectors) assertEmbeddingDimension(vector);

  const bodyVector = vectors[0]!;
  const chunkVectors = vectors.slice(1);

  await client.query(
    `UPDATE article_versions
        SET embedding = $1::vector
      WHERE article_version_id = $2`,
    [toVectorLiteral(bodyVector), articleVersionId],
  );

  await client.query("DELETE FROM article_chunks WHERE article_version_id = $1", [
    articleVersionId,
  ]);

  for (const [ordinal, chunk] of chunks.entries()) {
    await client.query(
      `INSERT INTO article_chunks
         (org_id, property_id, article_version_id, ordinal, body, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)`,
      [
        context.orgId,
        context.propertyId,
        articleVersionId,
        ordinal,
        chunk,
        toVectorLiteral(chunkVectors[ordinal]!),
      ],
    );
  }
  return chunks.length;
}

/**
 * Deletes the chunks of every OTHER version of the same article.
 *
 * This is what makes AC-1's second clause true — "every chunk resolves to a
 * current version". Chunks are derived data; the retired version keeps its
 * immutable body and its whole-body embedding, which is what a citation needs.
 * Scoped by article through `article_versions`, so an unrelated article's
 * current chunks are never touched.
 */
async function deleteRetiredChunks(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleId: string,
  keepArticleVersionId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM article_chunks
      WHERE org_id = $1
        AND property_id = $2
        AND article_version_id <> $3
        AND article_version_id IN (
              SELECT article_version_id
                FROM article_versions
               WHERE article_id = $4
            )`,
    [context.orgId, context.propertyId, keepArticleVersionId, articleId],
  );
}
