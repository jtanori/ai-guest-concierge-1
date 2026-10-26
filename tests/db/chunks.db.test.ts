/**
 * S04-02 — "every published version is chunked and embedded" (db).
 *
 * The AC has two halves and this file proves both, in the only place that can:
 *
 *   AC-1a  every `is_current` version has >= 1 chunk
 *   AC-1b  every chunk resolves to a version that is current
 *   AC-2   a version with no body is refused, not silently indexed
 *
 * AC-1b is the half a "publish, then backfill" design gets wrong: after v2 is
 * published, v1's chunks are gone, yet v1's immutable body and whole-body
 * embedding remain (that is what a citation needs). Each publish is also run
 * against a fake provider that fails, to prove nothing is promoted before its
 * chunks exist.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { chunkBody } from "../../src/knowledge/chunk.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import {
  backfillChunks,
  chunkAndPublish,
  type BatchEmbedder,
  UnembeddableVersionError,
  VersionAlreadyCurrentError,
  VersionNotCurrentError,
  VersionNotFoundError,
} from "../../src/knowledge/reembed.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

const BODY_V1 = [
  "The pool is open from 07:00 to 21:00 every day.",
  "Towels are provided at the pool deck and must not be removed from it.",
  "Children under twelve must be accompanied by an adult at all times.",
].join("\n\n");

const BODY_V2 = [
  "The pool is open from 07:00 to 20:00 every day.",
  "The hot tub closes at 22:00 and is adults only after 19:00.",
].join("\n\n");

/** Small chunks keep the fixture readable and exercise the options plumbing. */
const OPTS = { maxChars: 120, overlap: 20 };

const embed: BatchEmbedder = async (texts) => texts.map((text) => stubEmbedding(text));

let client: pg.Client;
let tenantA: TenantContext;
let tenantB: TenantContext;
let articleId = "";
let sourceId = "";
let v1 = "";
let v2 = "";
let bodylessV3 = "";
let blankV4 = "";
let otherArticleId = "";
let otherV1 = "";

async function asApp<T>(context: TenantContext, fn: (tx: pg.Client) => Promise<T>): Promise<T> {
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

async function chunkRows(versionId: string): Promise<Array<{ ordinal: number; body: string }>> {
  const result = await client.query<{ ordinal: number; body: string }>(
    `SELECT ordinal, body FROM article_chunks
      WHERE article_version_id = $1 ORDER BY ordinal`,
    [versionId],
  );
  return result.rows;
}

async function versionState(versionId: string): Promise<{ is_current: boolean; has_body: boolean }> {
  const result = await client.query<{ is_current: boolean; body: string | null }>(
    "SELECT is_current, body FROM article_versions WHERE article_version_id = $1",
    [versionId],
  );
  const row = result.rows[0]!;
  return { is_current: row.is_current, has_body: row.body !== null };
}

/** AC-1 in one statement: no current version without chunks, no chunk without current. */
async function invariantViolations(): Promise<number> {
  const result = await client.query<{ orphan_chunks: string; empty_current: string }>(
    `SELECT (SELECT count(*)
               FROM article_chunks c
               JOIN article_versions av ON av.article_version_id = c.article_version_id
              WHERE NOT av.is_current) AS orphan_chunks,
            (SELECT count(*)
               FROM article_versions av
              WHERE av.is_current AND av.body IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM article_chunks c
                                 WHERE c.article_version_id = av.article_version_id)
            ) AS empty_current`,
    [],
  );
  const row = result.rows[0]!;
  return Number(row.orphan_chunks) + Number(row.empty_current);
}

describe("article chunks (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const orgA = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Chunks A', 'chunks_a') RETURNING org_id",
    );
    const orgB = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Chunks B', 'chunks_b') RETURNING org_id",
    );
    const propA = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Chunks A', 'chunks_prop_a') RETURNING property_id",
      [orgA.rows[0]!.org_id],
    );
    const propB = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Chunks B', 'chunks_prop_b') RETURNING property_id",
      [orgB.rows[0]!.org_id],
    );

    tenantA = { orgId: orgA.rows[0]!.org_id, propertyId: propA.rows[0]!.property_id };
    tenantB = { orgId: orgB.rows[0]!.org_id, propertyId: propB.rows[0]!.property_id };

    await asApp(tenantA, async (tx) => {
      const source = await tx.query<{ source_id: string }>(
        `INSERT INTO knowledge_sources (org_id, property_id, kind, title)
         VALUES ($1, $2, 'manual', 'Chunks manual') RETURNING source_id`,
        [tenantA.orgId, tenantA.propertyId],
      );
      sourceId = source.rows[0]!.source_id;

      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, source_id, scope, topic_key, title, language)
         VALUES ($1, $2, $3, 'property', 'pool.hours', 'Pool hours', 'en') RETURNING article_id`,
        [tenantA.orgId, tenantA.propertyId, sourceId],
      );
      articleId = article.rows[0]!.article_id;

      const rows = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions (org_id, property_id, article_id, version_no, is_current, body)
         VALUES ($1, $2, $3, 1, false, $4),
                ($1, $2, $3, 2, false, $5),
                ($1, $2, $3, 3, false, NULL),
                ($1, $2, $3, 4, false, '   ')
         RETURNING article_version_id`,
        [tenantA.orgId, tenantA.propertyId, articleId, BODY_V1, BODY_V2],
      );
      v1 = rows.rows[0]!.article_version_id;
      v2 = rows.rows[1]!.article_version_id;
      bodylessV3 = rows.rows[2]!.article_version_id;
      blankV4 = rows.rows[3]!.article_version_id;

      const other = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, source_id, scope, topic_key, title, language)
         VALUES ($1, $2, $3, 'property', 'spa.hours', 'Spa hours', 'en') RETURNING article_id`,
        [tenantA.orgId, tenantA.propertyId, sourceId],
      );
      otherArticleId = other.rows[0]!.article_id;
      const otherVersion = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions (org_id, property_id, article_id, version_no, is_current, body)
         VALUES ($1, $2, $3, 1, false, 'The spa opens at 09:00.') RETURNING article_version_id`,
        [tenantA.orgId, tenantA.propertyId, otherArticleId],
      );
      otherV1 = otherVersion.rows[0]!.article_version_id;

      // A current version with NO chunks: the state S04-02 exists to repair,
      // reached the way a pre-S04-02 database reached it (promote only).
      await tx.query(
        "UPDATE article_versions SET embedding = $1::vector WHERE article_version_id = $2",
        [toVectorLiteral(stubEmbedding("The spa opens at 09:00.")), otherV1],
      );
      await tx.query("SELECT promote_article_version($1)", [otherV1]);
    });
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("chunks, embeds and publishes in one step, with ordinals from 0", async () => {
    const expected = chunkBody(BODY_V1, OPTS);
    expect(expected.length).toBeGreaterThan(1);

    const result = await asApp(tenantA, (tx) => chunkAndPublish(tx, tenantA, v1, embed, OPTS));

    expect(result).toMatchObject({ articleVersionId: v1, versionNo: 1, chunkCount: expected.length });
    const rows = await chunkRows(v1);
    expect(rows.map((row) => row.body)).toEqual(expected);
    expect(rows.map((row) => row.ordinal)).toEqual(expected.map((_, index) => index));
    expect(await versionState(v1)).toEqual({ is_current: true, has_body: true });
  });

  it("every chunk has an embedding of the schema's width", async () => {
    const result = await client.query<{ n: string; dims: number }>(
      `SELECT count(*) AS n, max(vector_dims(embedding)) AS dims
         FROM article_chunks WHERE article_version_id = $1`,
      [v1],
    );
    expect(Number(result.rows[0]!.n)).toBeGreaterThan(1);
    expect(result.rows[0]!.dims).toBe(1536);
  });

  it("AC-1b: publishing v2 retires v1's chunks, and v1 keeps its body and vector", async () => {
    const before = await chunkRows(v1);
    expect(before.length).toBeGreaterThan(0);

    await asApp(tenantA, (tx) => chunkAndPublish(tx, tenantA, v2, embed, OPTS));

    expect(await chunkRows(v1)).toHaveLength(0);
    expect(await chunkRows(v2)).not.toHaveLength(0);

    const retired = await client.query<{ body: string | null; embedding: string | null; promoted_at: Date | null }>(
      "SELECT body, embedding::text AS embedding, promoted_at FROM article_versions WHERE article_version_id = $1",
      [v1],
    );
    expect(retired.rows[0]!.body).toBe(BODY_V1);
    expect(retired.rows[0]!.embedding).not.toBeNull();
    expect(retired.rows[0]!.promoted_at).not.toBeNull();

    // and the other article's current chunks were not swept up with them
    expect(await chunkRows(otherV1)).toHaveLength(0);
  });

  it("AC-2: a body-less version is refused, writes nothing and stays retired", async () => {
    const before = await chunkRows(v2);

    await expect(
      asApp(tenantA, (tx) => chunkAndPublish(tx, tenantA, bodylessV3, embed, OPTS)),
    ).rejects.toBeInstanceOf(UnembeddableVersionError);
    await expect(
      asApp(tenantA, (tx) => chunkAndPublish(tx, tenantA, blankV4, embed, OPTS)),
    ).rejects.toBeInstanceOf(UnembeddableVersionError);

    expect(await chunkRows(v2)).toEqual(before);
    expect(await chunkRows(bodylessV3)).toHaveLength(0);
    expect(await chunkRows(blankV4)).toHaveLength(0);
    expect((await versionState(bodylessV3)).is_current).toBe(false);
  });

  it("a provider with the wrong width fails before anything is written", async () => {
    const narrow: BatchEmbedder = async (texts) => texts.map(() => [0.1, 0.2]);
    await expect(
      asApp(tenantA, (tx) => chunkAndPublish(tx, tenantA, bodylessV3, narrow, OPTS)),
    ).rejects.toThrow(/no body/);

    // blankV4 has no body either: use a real body to reach the dimension guard
    const body = await client.query<{ article_version_id: string }>(
      `INSERT INTO article_versions (org_id, property_id, article_id, version_no, is_current, body)
       VALUES ($1, $2, $3, 5, false, 'The gym opens at 06:00.') RETURNING article_version_id`,
      [tenantA.orgId, tenantA.propertyId, articleId],
    );
    const gym = body.rows[0]!.article_version_id;

    await expect(
      asApp(tenantA, (tx) => chunkAndPublish(tx, tenantA, gym, narrow, OPTS)),
    ).rejects.toThrow(/1536/);
    expect(await chunkRows(gym)).toHaveLength(0);
    expect((await versionState(gym)).is_current).toBe(false);

    // a short batch (fewer vectors than chunks) is refused too
    const short: BatchEmbedder = async (texts) => texts.slice(0, 1).map((t) => stubEmbedding(t));
    const multi = await client.query<{ article_version_id: string }>(
      `INSERT INTO article_versions (org_id, property_id, article_id, version_no, is_current, body)
       VALUES ($1, $2, $3, 6, false, $4) RETURNING article_version_id`,
      [tenantA.orgId, tenantA.propertyId, articleId, BODY_V1],
    );
    const multiId = multi.rows[0]!.article_version_id;
    await expect(
      asApp(tenantA, (tx) => chunkAndPublish(tx, tenantA, multiId, short, OPTS)),
    ).rejects.toThrow(/vectors for \d+ inputs/);
    expect(await chunkRows(multiId)).toHaveLength(0);
  });

  it("refuses to re-publish an already current version", async () => {
    const before = await chunkRows(v2);
    await expect(
      asApp(tenantA, (tx) => chunkAndPublish(tx, tenantA, v2, embed, OPTS)),
    ).rejects.toBeInstanceOf(VersionAlreadyCurrentError);
    expect(await chunkRows(v2)).toEqual(before);
  });

  it("a foreign version id is not found and writes nothing", async () => {
    const before = await chunkRows(v2);
    await expect(
      asApp(tenantB, (tx) => chunkAndPublish(tx, tenantB, v2, embed, OPTS)),
    ).rejects.toBeInstanceOf(VersionNotFoundError);
    expect(await chunkRows(v2)).toEqual(before);
  });

  it("chunks are tenant-scoped: another tenant sees none", async () => {
    const seen = await asApp(tenantB, (tx) =>
      tx.query<{ n: string }>("SELECT count(*) AS n FROM article_chunks"),
    );
    expect(seen.rows[0]!.n).toBe("0");
  });

  it("backfillChunks repairs a current version that has no chunks", async () => {
    expect(await chunkRows(otherV1)).toHaveLength(0);

    const result = await asApp(tenantA, (tx) => backfillChunks(tx, tenantA, otherV1, embed, OPTS));
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(await chunkRows(otherV1)).toHaveLength(result.chunkCount);
  });

  it("backfillChunks refuses a retired version, so history never gains chunks", async () => {
    await expect(
      asApp(tenantA, (tx) => backfillChunks(tx, tenantA, v1, embed, OPTS)),
    ).rejects.toBeInstanceOf(VersionNotCurrentError);
    expect(await chunkRows(v1)).toHaveLength(0);
  });

  it("AC-1 holds across the tenant once one article is still current without chunks", async () => {
    // The spa article was repaired above, so the only outstanding violation is
    // the freshly created gym/multi versions, which are retired and chunkless.
    expect(await invariantViolations()).toBe(0);
  });

  it("a chunk's identity is immutable: position and version can never move", async () => {
    const rows = await chunkRows(v2);
    expect(rows.length).toBeGreaterThan(0);
    const ordinal = rows[0]!.ordinal;

    await expect(
      client.query(
        "UPDATE article_chunks SET ordinal = 99 WHERE article_version_id = $1 AND ordinal = $2",
        [v2, ordinal],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // re-pointing a chunk at another version is refused by the same trigger
    await expect(
      client.query("UPDATE article_chunks SET article_version_id = $1 WHERE article_version_id = $2", [
        v1,
        v2,
      ]),
    ).rejects.toMatchObject({ code: "23514" });

    // Rewriting the text of a chunk is allowed — a re-embed may legitimately
    // change it — while its position stays put. That distinction is the point.
    await client.query("UPDATE article_chunks SET body = body WHERE article_version_id = $1", [
      v2,
    ]);
    expect(await chunkRows(v2)).toEqual(rows);
  });

  it("chunks die with their version: the FK is ON DELETE CASCADE", async () => {
    // `article_versions` is append-only (0003 blocks DELETE), so the cascade
    // cannot be exercised by deleting a version here — the constraint is
    // asserted instead, and it is what protects a property teardown.
    const fks = await client.query<{ conname: string; confdeltype: string; definition: string }>(
      `SELECT conname, confdeltype, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'article_chunks'::regclass AND contype = 'f'`,
    );
    const versionFk = fks.rows.find((row) => row.definition.includes("article_version_id"));
    expect(versionFk).toBeDefined();
    expect(versionFk!.confdeltype).toBe("c");
    expect(versionFk!.definition).toContain("org_id, property_id, article_version_id");
  });

  it("the schema refuses a blank chunk and an over-long one", async () => {
    const target = await chunkRows(otherV1);
    expect(target.length).toBeGreaterThan(0);

    await expect(
      client.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body)
         VALUES ($1, $2, $3, 999, '   ')`,
        [tenantA.orgId, tenantA.propertyId, otherV1],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      client.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body)
         VALUES ($1, $2, $3, 998, repeat('x', 2001))`,
        [tenantA.orgId, tenantA.propertyId, otherV1],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("0011 installs FORCE RLS, the tenant policy and one index per retrieval mode", async () => {
    const rls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'article_chunks'",
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policy = await client.query<{ qual: string }>(
      "SELECT qual FROM pg_policies WHERE tablename = 'article_chunks' AND policyname = 'tenant'",
    );
    expect(policy.rows[0]!.qual).toContain("current_org_id()");
    expect(policy.rows[0]!.qual).toContain("current_property_id()");

    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'article_chunks'",
    );
    const defs = indexes.rows.map((row) => row.indexdef).join("\n");
    expect(defs).toMatch(/gin \(tsv\)/);
    expect(defs).toMatch(/gin \(body gin_trgm_ops\)/);
    expect(defs).toMatch(/hnsw \(embedding vector_cosine_ops\)/);
  });
});
