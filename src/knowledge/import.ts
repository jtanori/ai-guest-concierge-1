/**
 * S03-02 - all-or-nothing CSV import through S03-01's article service.
 *
 * The caller owns BEGIN/COMMIT (the future staff route/CLI). Validation runs
 * before any SELECT/INSERT; a row failure throws with the full preview, and a
 * database failure part-way through rolls the whole file back with the
 * caller's transaction.
 */
import type pg from "pg";
import {
  assertTenantShape,
  TenantContextError,
  type TenantContext,
} from "../db/tenant.ts";
import { createArticle, editArticle } from "./articles.ts";
import {
  CsvImportValidationError,
  previewArticleCsv,
  type CsvPreview,
} from "./csv.ts";

export interface CsvImportResult {
  imported: number;
  created: number;
  updated: number;
  unchanged: number;
  preview: CsvPreview;
}

async function assertTenantTransaction(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<void> {
  const result = await client.query<{ org: string | null; prop: string | null }>(
    "SELECT current_org_id()::text AS org, current_property_id()::text AS prop",
  );
  const org = result.rows[0]?.org?.toLowerCase() ?? null;
  const prop = result.rows[0]?.prop?.toLowerCase() ?? null;
  if (
    org !== context.orgId.toLowerCase() ||
    prop !== context.propertyId.toLowerCase()
  ) {
    throw new TenantContextError(
      "importArticleCsv requires a withTenant transaction matching the supplied TenantContext",
    );
  }
}

export async function importArticleCsv(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  text: string,
): Promise<CsvImportResult> {
  assertTenantShape(context);
  await assertTenantTransaction(client, context);

  const preview = previewArticleCsv(text);
  if (preview.errors.length > 0) throw new CsvImportValidationError(preview);

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of preview.rows) {
    const existing = await client.query<{ article_id: string }>(
      `SELECT article_id
         FROM knowledge_articles
        WHERE org_id = $1
          AND property_id = $2
          AND scope = 'property'
          AND topic_key = $3`,
      [context.orgId, context.propertyId, row.draft.topicKey],
    );

    const articleId = existing.rows[0]?.article_id;
    if (articleId === undefined) {
      await createArticle(client, context, actor, row.draft);
      created += 1;
    } else {
      const edited = await editArticle(client, context, actor, articleId, row.draft);
      if (edited.wrote) updated += 1;
      else unchanged += 1;
    }
  }

  return {
    imported: created + updated + unchanged,
    created,
    updated,
    unchanged,
    preview,
  };
}
