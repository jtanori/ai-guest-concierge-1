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
import { assertEmbeddingDimension, toVectorLiteral } from "./embedding.ts";

export type Embedder = (text: string) => Promise<number[]>;

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

  return { articleVersionId, versionNo: row.version_no };
}
