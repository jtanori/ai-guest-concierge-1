/**
 * S03-02 - all-or-nothing CSV import under RLS.
 *
 * The unit suite covers parsing. These tests prove the commit path: 100 rows
 * create 100 articles + versions, a second file appends versions rather than
 * duplicating topics, validation failures write nothing, tenants stay isolated,
 * and a database failure mid-file rolls the whole file back.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { listArticles } from "../../src/knowledge/articles.ts";
import { importArticleCsv } from "../../src/knowledge/import.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

const HEADER = "topic_key,title,language,body";

let client: pg.Client;
let tenantA: TenantContext;
let tenantB: TenantContext;
let actorA: { userId: string };
let actorB: { userId: string };

function csvFor(prefix: string, count: number, bodySuffix = ""): string {
  const rows = Array.from(
    { length: count },
    (_, index) =>
      `${prefix}${index},${prefix}${index},en,Body ${prefix}${index}${bodySuffix}.`,
  );
  return `${HEADER}\n${rows.join("\n")}`;
}

async function asApp<T>(
  context: TenantContext,
  fn: (tx: pg.Client) => Promise<T>,
): Promise<T> {
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

async function stats(
  propertyId: string,
  topicPrefix: string,
): Promise<{ articles: number; versions: number; maxVersion: number }> {
  const articles = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM knowledge_articles
      WHERE property_id = $1 AND topic_key LIKE $2`,
    [propertyId, `${topicPrefix}%`],
  );
  const versions = await client.query<{ count: string; max: string | null }>(
    `SELECT count(*)::text AS count, max(av.version_no)::text AS max
       FROM article_versions av
       JOIN knowledge_articles ka
         ON ka.article_id = av.article_id
        AND ka.org_id = av.org_id
        AND ka.property_id = av.property_id
      WHERE av.property_id = $1 AND ka.topic_key LIKE $2`,
    [propertyId, `${topicPrefix}%`],
  );
  return {
    articles: Number(articles.rows[0]!.count),
    versions: Number(versions.rows[0]!.count),
    maxVersion: Number(versions.rows[0]!.max ?? 0),
  };
}

async function auditRows(propertyId: string): Promise<
  Array<{ action: string; detail: Record<string, unknown> }>
> {
  const result = await client.query<{
    action: string;
    detail: Record<string, unknown>;
  }>(
    `SELECT action, detail
       FROM audit_log
      WHERE property_id = $1
      ORDER BY audit_id`,
    [propertyId],
  );
  return result.rows;
}

async function versionAudits(propertyId: string, topicPrefix: string): Promise<number> {
  const rows = await auditRows(propertyId);
  return rows.filter(
    (row) =>
      row.action === "article.version_created" &&
      String(row.detail.topic_key ?? "").startsWith(topicPrefix),
  ).length;
}

describe("CSV import (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const orgA = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Import A', 'import_a') RETURNING org_id",
    );
    const orgB = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Import B', 'import_b') RETURNING org_id",
    );
    const propertyA = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Import A', 'import_property_a') RETURNING property_id",
      [orgA.rows[0]!.org_id],
    );
    const propertyB = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Import B', 'import_property_b') RETURNING property_id",
      [orgB.rows[0]!.org_id],
    );

    tenantA = { orgId: orgA.rows[0]!.org_id, propertyId: propertyA.rows[0]!.property_id };
    tenantB = { orgId: orgB.rows[0]!.org_id, propertyId: propertyB.rows[0]!.property_id };

    const userA = await client.query<{ user_id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('import-a@example.mx', 'Importer A') RETURNING user_id",
    );
    const userB = await client.query<{ user_id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('import-b@example.mx', 'Importer B') RETURNING user_id",
    );
    actorA = { userId: userA.rows[0]!.user_id };
    actorB = { userId: userB.rows[0]!.user_id };
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("imports 100 rows as 100 articles and 100 retired versions", async () => {
    const result = await asApp(tenantA, (tx) =>
      importArticleCsv(tx, tenantA, actorA, csvFor("bulk.import.", 100)),
    );

    expect(result).toMatchObject({ imported: 100, created: 100, updated: 0 });
    expect(result.preview.counts).toEqual({ total: 100, valid: 100, invalid: 0 });
    expect(await stats(tenantA.propertyId, "bulk.import.")).toEqual({
      articles: 100,
      versions: 100,
      maxVersion: 1,
    });

    const ours = (await asApp(tenantA, (tx) => listArticles(tx, tenantA))).filter((row) =>
      row.topicKey.startsWith("bulk.import."),
    );
    expect(ours).toHaveLength(100);
    expect(
      ours.every(
        (row) => row.versionCount === 1 && row.currentVersionId === null,
      ),
    ).toBe(true);
    expect(await versionAudits(tenantA.propertyId, "bulk.import.")).toBe(100);
  });

  it("updates existing topics on re-import instead of duplicating articles", async () => {
    const result = await asApp(tenantA, (tx) =>
      importArticleCsv(
        tx,
        tenantA,
        actorA,
        csvFor("bulk.import.", 100, " v2"),
      ),
    );

    expect(result).toMatchObject({ imported: 100, created: 0, updated: 100 });
    expect(await stats(tenantA.propertyId, "bulk.import.")).toEqual({
      articles: 100,
      versions: 200,
      maxVersion: 2,
    });

    const ours = (await asApp(tenantA, (tx) => listArticles(tx, tenantA))).filter((row) =>
      row.topicKey.startsWith("bulk.import."),
    );
    expect(ours).toHaveLength(100);
    expect(ours.every((row) => row.versionCount === 2)).toBe(true);
    expect(await versionAudits(tenantA.propertyId, "bulk.import.")).toBe(200);
  });

  it("writes nothing when any row fails validation", async () => {
    const csv = [
      HEADER,
      "invalid.import.0,Invalid 0,en,Body.",
      "invalid.import.1,Invalid 1,fr,Body.",
      "invalid.import.2,Invalid 2,en,Body.",
    ].join("\n");

    await expect(
      asApp(tenantA, (tx) => importArticleCsv(tx, tenantA, actorA, csv)),
    ).rejects.toMatchObject({
      name: "CsvImportValidationError",
      preview: {
        errors: [{ row: 2, field: "language" }],
      },
    });

    expect(await stats(tenantA.propertyId, "invalid.import.")).toEqual({
      articles: 0,
      versions: 0,
      maxVersion: 0,
    });
    expect(await versionAudits(tenantA.propertyId, "invalid.import.")).toBe(0);
  });

  it("creates new topics and edits existing ones in the same file", async () => {
    const csv = [
      HEADER,
      "bulk.import.0,Bulk 0,en,Bulk body 0 v3.",
      "mixed.new,Mixed,es,Contenido nuevo.",
    ].join("\n");

    const result = await asApp(tenantA, (tx) =>
      importArticleCsv(tx, tenantA, actorA, csv),
    );
    expect(result).toMatchObject({ imported: 2, created: 1, updated: 1 });

    expect(await stats(tenantA.propertyId, "mixed.new")).toEqual({
      articles: 1,
      versions: 1,
      maxVersion: 1,
    });
    const bulk = (await asApp(tenantA, (tx) => listArticles(tx, tenantA))).find(
      (row) => row.topicKey === "bulk.import.0",
    );
    expect(bulk).toMatchObject({ versionCount: 3 });
  });

  it("keeps the same topic isolated per tenant", async () => {
    const csv = `${HEADER}\nforeign.only,Foreign,en,Body.\n`;

    expect(
      await asApp(tenantB, (tx) => importArticleCsv(tx, tenantB, actorB, csv)),
    ).toMatchObject({ imported: 1, created: 1, updated: 0 });
    expect(
      await asApp(tenantA, (tx) => importArticleCsv(tx, tenantA, actorA, csv)),
    ).toMatchObject({ imported: 1, created: 1, updated: 0 });

    const a = (await asApp(tenantA, (tx) => listArticles(tx, tenantA))).find(
      (row) => row.topicKey === "foreign.only",
    );
    const b = (await asApp(tenantB, (tx) => listArticles(tx, tenantB))).find(
      (row) => row.topicKey === "foreign.only",
    );
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.articleId).not.toBe(b!.articleId);
    expect(await stats(tenantA.propertyId, "foreign.only")).toEqual({
      articles: 1,
      versions: 1,
      maxVersion: 1,
    });
    expect(await stats(tenantB.propertyId, "foreign.only")).toEqual({
      articles: 1,
      versions: 1,
      maxVersion: 1,
    });
  });

  it("rolls the whole file back when a database write fails mid-file", async () => {
    await client.query(`
      CREATE OR REPLACE FUNCTION test_fail_import_versions()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.body = 'ZZ_FAIL_IMPORT' THEN
          RAISE EXCEPTION 'forced import failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`
      CREATE TRIGGER test_fail_import_versions
      BEFORE INSERT ON article_versions
      FOR EACH ROW EXECUTE FUNCTION test_fail_import_versions()
    `);

    try {
      const csv = [
        HEADER,
        "rollback.import.0,Rollback 0,en,Body.",
        "rollback.import.1,Rollback 1,en,ZZ_FAIL_IMPORT",
      ].join("\n");

      await expect(
        asApp(tenantA, (tx) => importArticleCsv(tx, tenantA, actorA, csv)),
      ).rejects.toThrow(/forced import failure/);

      expect(await stats(tenantA.propertyId, "rollback.import.")).toEqual({
        articles: 0,
        versions: 0,
        maxVersion: 0,
      });
      expect(await versionAudits(tenantA.propertyId, "rollback.import.")).toBe(0);
    } finally {
      await client.query("DROP TRIGGER IF EXISTS test_fail_import_versions ON article_versions");
      await client.query("DROP FUNCTION IF EXISTS test_fail_import_versions()");
    }
  });
});
