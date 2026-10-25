/**
 * S02-05 - is_current retrieval filtering + re-embed/publish.
 *
 * The AC's failure mode is literal here: after v2 is published, a lexical
 * query for text that exists ONLY in v1 must return zero rows, while v1 stays
 * selectable by id as history. The vector path is checked separately so the
 * filter is proven on both modes.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import {
  reembedAndPublish,
  UnembeddableVersionError,
  VersionAlreadyCurrentError,
  VersionNotFoundError,
} from "../../src/knowledge/reembed.ts";
import { EmbeddingDimensionError } from "../../src/knowledge/embedding.ts";
import {
  retrieveCurrentVersions,
  type RetrievalInput,
} from "../../src/knowledge/retrieval.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

const OLD_TOKEN = "zzoldtoken";
const NEW_TOKEN = "zznewtoken";
const OLD_BODY = `Pool hours are 07:00-21:00. ${OLD_TOKEN} applies to the old policy.`;
const NEW_BODY = `Pool hours are 07:00-20:00. ${NEW_TOKEN} applies to the new policy.`;

let client: pg.Client;
let tenantA: TenantContext;
let tenantB: TenantContext;
let articleId: string;
let v1: string;
let v2: string;
let nullBodyVersion: string;
let wrongDimensionVersion: string;
let oldEmbedding: number[];

async function asApp<T>(
  context: TenantContext,
  fn: (tx: pg.Client) => Promise<T>,
): Promise<T> {
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

describe("is_current retrieval + reembed (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const orgA = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Retrieval A', 'retrieval_a') RETURNING org_id",
    );
    const orgB = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Retrieval B', 'retrieval_b') RETURNING org_id",
    );
    const propertyA = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Property A', 'retrieval_property_a') RETURNING property_id",
      [orgA.rows[0]!.org_id],
    );
    const propertyB = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Property B', 'retrieval_property_b') RETURNING property_id",
      [orgB.rows[0]!.org_id],
    );

    tenantA = { orgId: orgA.rows[0]!.org_id, propertyId: propertyA.rows[0]!.property_id };
    tenantB = { orgId: orgB.rows[0]!.org_id, propertyId: propertyB.rows[0]!.property_id };
    oldEmbedding = stubEmbedding(OLD_BODY);

    await asApp(tenantA, async (tx) => {
      const source = await tx.query<{ source_id: string }>(
        `INSERT INTO knowledge_sources (org_id, property_id, kind, title)
         VALUES ($1, $2, 'manual', 'Retrieval test manual')
         RETURNING source_id`,
        [tenantA.orgId, tenantA.propertyId],
      );
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles
           (org_id, property_id, source_id, scope, topic_key, title, language)
         VALUES ($1, $2, $3, 'property', 'pool.hours', 'Pool hours', 'en')
         RETURNING article_id`,
        [tenantA.orgId, tenantA.propertyId, source.rows[0]!.source_id],
      );
      articleId = article.rows[0]!.article_id;

      const first = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, $4, $5::vector)
         RETURNING article_version_id`,
        [tenantA.orgId, tenantA.propertyId, articleId, OLD_BODY, toVectorLiteral(oldEmbedding)],
      );
      v1 = first.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [v1]);

      const second = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body)
         VALUES ($1, $2, $3, 2, false, $4)
         RETURNING article_version_id`,
        [tenantA.orgId, tenantA.propertyId, articleId, NEW_BODY],
      );
      v2 = second.rows[0]!.article_version_id;

      const noBody = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body)
         VALUES ($1, $2, $3, 3, false, NULL)
         RETURNING article_version_id`,
        [tenantA.orgId, tenantA.propertyId, articleId],
      );
      nullBodyVersion = noBody.rows[0]!.article_version_id;

      const wrongDimension = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body)
         VALUES ($1, $2, $3, 4, false, 'zzwrongdimension body')
         RETURNING article_version_id`,
        [tenantA.orgId, tenantA.propertyId, articleId],
      );
      wrongDimensionVersion = wrongDimension.rows[0]!.article_version_id;
    });
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("returns the current v1 for a token unique to v1", async () => {
    const hits = await asApp(tenantA, (tx) =>
      retrieveCurrentVersions(tx, tenantA, { text: OLD_TOKEN }),
    );
    expect(hits.map((hit) => hit.articleVersionId)).toEqual([v1]);
    expect(hits[0]).toMatchObject({
      articleId,
      topicKey: "pool.hours",
      title: "Pool hours",
      body: OLD_BODY,
      language: "en",
      versionNo: 1,
    });
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("publishing v2 makes v1's unique text unretrievable and returns only v2", async () => {
    const seen: string[] = [];
    const published = await asApp(tenantA, (tx) =>
      reembedAndPublish(tx, tenantA, v2, async (text) => {
        seen.push(text);
        return stubEmbedding(text);
      }),
    );
    expect(published).toEqual({ articleVersionId: v2, versionNo: 2 });
    expect(seen).toEqual([NEW_BODY]);

    const oldHits = await asApp(tenantA, (tx) =>
      retrieveCurrentVersions(tx, tenantA, { text: OLD_TOKEN }),
    );
    expect(oldHits).toEqual([]);

    const newHits = await asApp(tenantA, (tx) =>
      retrieveCurrentVersions(tx, tenantA, { text: NEW_TOKEN }),
    );
    expect(newHits.map((hit) => hit.articleVersionId)).toEqual([v2]);
    expect(newHits[0]!.body).toBe(NEW_BODY);
    expect(newHits[0]!.versionNo).toBe(2);
  });

  it("keeps retired history selectable by article_version_id (citations still resolve)", async () => {
    const history = await asApp(tenantA, (tx) =>
      tx.query<{ body: string; is_current: boolean; promoted_at: Date | null }>(
        "SELECT body, is_current, promoted_at FROM article_versions WHERE article_version_id = $1",
        [v1],
      ),
    );
    expect(history.rowCount).toBe(1);
    expect(history.rows[0]).toMatchObject({ body: OLD_BODY, is_current: false });
    expect(history.rows[0]!.promoted_at).not.toBeNull();
  });

  it("filters is_current on the vector path too", async () => {
    const hits = await asApp(tenantA, (tx) =>
      retrieveCurrentVersions(tx, tenantA, { text: "", embedding: oldEmbedding }),
    );
    expect(hits.map((hit) => hit.articleVersionId)).toEqual([v2]);
    expect(hits.some((hit) => hit.articleVersionId === v1)).toBe(false);
  });

  it("never returns a retired version even when it is the strongest lexical match", async () => {
    const hits = await asApp(tenantA, (tx) =>
      retrieveCurrentVersions(tx, tenantA, { text: `${OLD_TOKEN} ${OLD_TOKEN} ${OLD_TOKEN}` }),
    );
    expect(hits).toEqual([]);
  });

  it("has no include-retired option and pins the literal filter in both SQL paths", () => {
    const source = readFileSync(
      new URL("../../src/knowledge/retrieval.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/AND av\.is_current\b/g) ?? []).toHaveLength(2);
    expect(source).not.toMatch(/includeRetired|include_retired/);

    // @ts-expect-error - the public input type deliberately has no escape hatch
    const forbidden: RetrievalInput = { text: "pool", includeRetired: true };
    void forbidden;
  });

  it("refuses unknown, foreign, null-body, already-current and wrong-dimension versions", async () => {
    await expect(
      asApp(tenantA, (tx) =>
        reembedAndPublish(tx, tenantA, randomUUID(), async (text) => stubEmbedding(text)),
      ),
    ).rejects.toBeInstanceOf(VersionNotFoundError);

    await expect(
      asApp(tenantB, (tx) =>
        reembedAndPublish(tx, tenantB, v1, async (text) => stubEmbedding(text)),
      ),
    ).rejects.toBeInstanceOf(VersionNotFoundError);

    await expect(
      asApp(tenantA, (tx) =>
        reembedAndPublish(tx, tenantA, nullBodyVersion, async (text) => stubEmbedding(text)),
      ),
    ).rejects.toBeInstanceOf(UnembeddableVersionError);

    await expect(
      asApp(tenantA, (tx) =>
        reembedAndPublish(tx, tenantA, v2, async (text) => stubEmbedding(text)),
      ),
    ).rejects.toBeInstanceOf(VersionAlreadyCurrentError);

    await expect(
      asApp(tenantA, (tx) =>
        reembedAndPublish(tx, tenantA, wrongDimensionVersion, async () => [0.1, 0.2]),
      ),
    ).rejects.toBeInstanceOf(EmbeddingDimensionError);

    const stillNull = await asApp(tenantA, (tx) =>
      tx.query<{ embedding: string | null }>(
        "SELECT embedding::text AS embedding FROM article_versions WHERE article_version_id = $1",
        [wrongDimensionVersion],
      ),
    );
    expect(stillNull.rows[0]!.embedding).toBeNull();
  });

  it("rolls the embedding write back when promotion fails (no half-published version)", async () => {
    const atomicV1 = await asApp(tenantA, async (tx) => {
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles
           (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'spa.services', 'Spa services', 'en')
         RETURNING article_id`,
        [tenantA.orgId, tenantA.propertyId],
      );
      const atomicArticleId = article.rows[0]!.article_id;

      const first = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, 'atomic old zzatomic', $4::vector)
         RETURNING article_version_id`,
        [
          tenantA.orgId,
          tenantA.propertyId,
          atomicArticleId,
          toVectorLiteral(stubEmbedding("atomic old zzatomic")),
        ],
      );
      const firstId = first.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [firstId]);

      const second = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 2, false, 'atomic new zzatomic', $4::vector)
         RETURNING article_version_id`,
        [
          tenantA.orgId,
          tenantA.propertyId,
          atomicArticleId,
          toVectorLiteral(stubEmbedding("atomic new zzatomic")),
        ],
      );
      await tx.query("SELECT promote_article_version($1)", [second.rows[0]!.article_version_id]);

      // Make the retired history look like an unembedded row, then prove the
      // failed promotion rolls the backfill back with it.
      await tx.query("UPDATE article_versions SET embedding = NULL WHERE article_version_id = $1", [
        firstId,
      ]);
      return firstId;
    });

    await expect(
      asApp(tenantA, (tx) =>
        reembedAndPublish(tx, tenantA, atomicV1, async (text) => stubEmbedding(text)),
      ),
    ).rejects.toThrow(/retired history/);

    const after = await asApp(tenantA, (tx) =>
      tx.query<{ embedding: string | null }>(
        "SELECT embedding::text AS embedding FROM article_versions WHERE article_version_id = $1",
        [atomicV1],
      ),
    );
    expect(after.rows[0]!.embedding).toBeNull();
  });
});
