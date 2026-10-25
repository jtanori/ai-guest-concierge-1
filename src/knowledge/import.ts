/**
 * S03-02 - all-or-nothing CSV import through S03-01's article service.
 *
 * The caller owns BEGIN/COMMIT (the future staff route/CLI). Validation runs
 * before any SELECT/INSERT; a row failure throws with the full preview, and a
 * database failure part-way through rolls the whole file back with the
 * caller's transaction.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
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
  preview: CsvPreview;
}

export async function importArticleCsv(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  text: string,
): Promise<CsvImportResult> {
  assertTenantShape(context);

  const preview = previewArticleCsv(text);
  if (preview.errors.length > 0) throw new CsvImportValidationError(preview);

  let created = 0;
  let updated = 0;

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
      await editArticle(client, context, actor, articleId, row.draft);
      updated += 1;
    }
  }

  return {
    imported: preview.rows.length,
    created,
    updated,
    preview,
  };
}
