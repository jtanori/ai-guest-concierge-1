/**
 * S04-03 — hybrid retrieval over the chunk layer.
 *
 * What is pinned here, one AC at a time:
 *
 *  - AC-1 `is_current`: after v2 is published, a query for text that exists
 *    ONLY in v1's chunks returns nothing. The filter is a literal in all three
 *    candidate statements (also asserted by grep in retrieval.db.test.ts).
 *  - AC-2 property over brand: when both scopes cover a `topic_key`, the
 *    hotel's own text is what comes back — even when the brand text scores
 *    higher.
 *  - The fusion itself: a hit reports the WHOLE version body (what S05 cites)
 *    plus `matchedChunk` (the paragraph that earned the score), and `weights`
 *    can switch a branch off.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { retrieveCurrentVersions, type RetrievalHit } from "../../src/knowledge/retrieval.ts";
import { preferProperty, resolveTopic } from "../../src/knowledge/resolve.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

let client: pg.Client;
let tenant: TenantContext;

interface SeedInput {
  scope: "brand" | "property";
  topicKey: string;
  title: string;
  /** One chunk per element; the version body is their blank-line join. */
  chunks: string[];
  /** Per-chunk vectors; defaults to the stub embedding of each chunk. */
  vectors?: number[][];
}

let publishedV1: { versionId: string; articleId: string; body: string };

/**
 * Publishes one chunked article: version row, promotion, then its chunks —
 * the same end state `chunkAndPublish` produces, with exact control over the
 * vectors so the vector branch is deterministic.
 */
async function seedArticle(input: SeedInput): Promise<{ versionId: string; articleId: string; body: string }> {
  const body = input.chunks.join("\n\n");
  const vectors = input.vectors ?? input.chunks.map((chunk) => stubEmbedding(chunk));

  return withTenant(client, tenant, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    const article = await tx.query<{ article_id: string }>(
      `INSERT INTO knowledge_articles
         (org_id, property_id, scope, topic_key, title, language)
       VALUES ($1, $2, $3, $4, $5, 'es')
       RETURNING article_id`,
      [tenant.orgId, tenant.propertyId, input.scope, input.topicKey, input.title],
    );
    const articleId = article.rows[0]!.article_id;

    const version = await tx.query<{ article_version_id: string }>(
      `INSERT INTO article_versions
         (org_id, property_id, article_id, version_no, is_current, body, embedding)
       VALUES ($1, $2, $3, 1, false, $4, $5::vector)
       RETURNING article_version_id`,
      [tenant.orgId, tenant.propertyId, articleId, body, toVectorLiteral(stubEmbedding(body))],
    );
    const versionId = version.rows[0]!.article_version_id;
    await tx.query("SELECT promote_article_version($1)", [versionId]);

    for (const [ordinal, chunk] of input.chunks.entries()) {
      await tx.query(
        `INSERT INTO article_chunks
           (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [
          tenant.orgId,
          tenant.propertyId,
          versionId,
          ordinal,
          chunk,
          toVectorLiteral(vectors[ordinal]!),
        ],
      );
    }
    return { versionId, articleId, body };
  });
}

async function asApp<T>(fn: (tx: pg.Client) => Promise<T>): Promise<T> {
  return withTenant(client, tenant, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

function retrieve(input: Parameters<typeof retrieveCurrentVersions>[2]): Promise<RetrievalHit[]> {
  return asApp((tx) => retrieveCurrentVersions(tx, tenant, input));
}

/** A 1536-dim basis vector: cosine distance 0 to itself, 1 to any other basis. */
function basisVector(index: number): number[] {
  const vector = new Array<number>(1536).fill(0);
  vector[index] = 1;
  return vector;
}

describe("hybrid retrieval (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const org = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Hybrid', 'hybrid_org') RETURNING org_id",
    );
    const property = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Hybrid', 'hybrid_property') RETURNING property_id",
      [org.rows[0]!.org_id],
    );
    tenant = { orgId: org.rows[0]!.org_id, propertyId: property.rows[0]!.property_id };

    // A property article with two chunks: only the second one mentions the spa.
    publishedV1 = await seedArticle({
      scope: "property",
      topicKey: "pool.hours",
      title: "Horario de la alberca",
      chunks: [
        "La alberca abre a las 07:00 todos los días del año.",
        "La alberca cierra a las 21:00 y el spa cierra a las 20:00.",
      ],
    });

    // Brand content the property has NOT written: brand exists to fill gaps.
    await seedArticle({
      scope: "brand",
      topicKey: "wifi.access",
      title: "Wi-Fi",
      chunks: ["La contraseña del wifi se entrega en recepción."],
    });

    // Same topic from both scopes: the property's text must win.
    await seedArticle({
      scope: "brand",
      topicKey: "spa.hours",
      title: "Spa",
      chunks: ["El spa del hotel cierra a las 20:00; reserve en recepción."],
    });
    await seedArticle({
      scope: "property",
      topicKey: "spa.hours",
      title: "Spa (horario local)",
      chunks: ["El spa de este hotel cierra a las 19:00 los días festivos."],
    });
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("returns the whole version body plus the chunk that matched", async () => {
    const hits = await retrieve({ text: "spa cierra" });
    expect(hits.length).toBeGreaterThan(0);

    const pool = hits.find((hit) => hit.topicKey === "pool.hours");
    expect(pool).toBeDefined();
    expect(pool!.articleVersionId).toBe(publishedV1.versionId);
    // The citation unit stays the version (S05 quotes `body`), not the chunk.
    expect(pool!.body).toBe(publishedV1.body);
    expect(pool!.matchedChunk).toBeDefined();
    expect(pool!.matchedChunk!.ordinal).toBe(1);
    expect(pool!.matchedChunk!.body).toContain("spa cierra a las 20:00");
    // The chunk is a substring of the body the hit reports — no second source.
    expect(pool!.body).toContain(pool!.matchedChunk!.body);
    expect(pool!.scope).toBe("property");
    expect(pool!.score).toBeGreaterThan(0);
  });

  it("ranks by fused reciprocal rank, and reports which branches matched", async () => {
    const hits = await retrieve({ text: "alberca" });
    const scores = hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
    // "alberca" is in both chunks of one version, so exactly one hit per version.
    expect(new Set(hits.map((hit) => hit.articleVersionId)).size).toBe(hits.length);
    expect(hits[0]!.branches).toContain("lexical");
  });

  it("finds a misspelt term through the trigram branch, and a zero weight disables it", async () => {
    // "albcrca" matches neither token in the tsvector; trigram carries it.
    const fuzzy = await retrieve({ text: "albcrca" });
    expect(fuzzy.map((hit) => hit.topicKey)).toContain("pool.hours");
    expect(fuzzy[0]!.branches).toContain("trigram");

    const trigramOff = await retrieve({
      text: "albcrca",
      weights: { lexical: 1, vector: 1, trigram: 0 },
    });
    expect(trigramOff.map((hit) => hit.topicKey)).not.toContain("pool.hours");
  });

  it("answers the vector branch from an embedding alone", async () => {
    // A chunk whose text shares no token with the query, found by vector only.
    const marker = await seedArticle({
      scope: "property",
      topicKey: "parking.access",
      title: "Estacionamiento",
      chunks: ["El estacionamiento es subterráneo y tiene sesenta cajones."],
      vectors: [basisVector(7)],
    });

    const hits = await retrieve({ text: "zzzqqq", embedding: basisVector(7) });
    expect(hits[0]!.articleVersionId).toBe(marker.versionId);
    expect(hits[0]!.branches).toEqual(["vector"]);
    expect(hits[0]!.score).toBeCloseTo(1 / 61, 10);
  });

  it("lets the property's text override brand text on the same topic_key (AC-2)", async () => {
    // Both scopes match this phrasing; only the property's article survives.
    const hits = await retrieve({ text: "spa cierra" });
    const spa = hits.filter((hit) => hit.topicKey === "spa.hours");
    expect(spa).toHaveLength(1);
    expect(spa[0]!.scope).toBe("property");
    expect(spa[0]!.title).toBe("Spa (horario local)");

    // Brand content the property never wrote still comes through.
    const wifi = await retrieve({ text: "contraseña wifi" });
    expect(wifi.find((hit) => hit.topicKey === "wifi.access")?.scope).toBe("brand");
  });

  it("shadows brand text for a covered topic even when the property's chunk does not score", async () => {
    // "recepción" appears only in the BRAND spa chunk ("reserve en recepción").
    // The hotel has published its own spa.hours article, so brand text is not a
    // fallback for that topic: answering "the spa closes at 20:00" over a local
    // "19:00 on holidays" is the exact wrong answer this rule prevents. No hit
    // is the honest outcome, and S05 escalates on it.
    const hits = await retrieve({ text: "recepción" });
    expect(hits.filter((hit) => hit.topicKey === "spa.hours")).toEqual([]);
    // Uncovered topics are untouched by the rule: the same word still finds
    // the brand wifi article, because the property never wrote one.
    expect(hits.find((hit) => hit.topicKey === "wifi.access")?.scope).toBe("brand");
  });

  it("restricts candidates when a scope is asked for explicitly", async () => {
    const brandOnly = await retrieve({ text: "spa cierra", scope: "brand" });
    expect(brandOnly.every((hit) => hit.scope === "brand")).toBe(true);

    const propertyOnly = await retrieve({ text: "spa cierra", scope: "property" });
    expect(propertyOnly.every((hit) => hit.scope === "property")).toBe(true);
  });

  it("never returns a retired version's chunks once v2 is current (AC-1)", async () => {
    const v1Only = "zzretiredtoken";

    const article = await seedArticle({
      scope: "property",
      topicKey: "gym.hours",
      title: "Gimnasio",
      chunks: [`El gimnasio abre a las 05:00. ${v1Only}.`],
    });

    const before = await retrieve({ text: v1Only });
    expect(before.map((hit) => hit.articleVersionId)).toEqual([article.versionId]);

    const secondBody = "El gimnasio abre a las 06:00 desde enero.";
    await asApp(async (tx) => {
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 2, false, $4, $5::vector)
         RETURNING article_version_id`,
        [
          tenant.orgId,
          tenant.propertyId,
          article.articleId,
          secondBody,
          toVectorLiteral(stubEmbedding(secondBody)),
        ],
      );
      const v2 = version.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [v2]);
      await tx.query("DELETE FROM article_chunks WHERE article_version_id = $1", [article.versionId]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [
          tenant.orgId,
          tenant.propertyId,
          v2,
          secondBody,
          toVectorLiteral(stubEmbedding(secondBody)),
        ],
      );
    });

    // The retired body is still there, immutably, for citations...
    const history = await client.query("SELECT 1 FROM article_versions WHERE article_version_id = $1", [
      article.versionId,
    ]);
    expect(history.rowCount).toBe(1);
    // ...but nothing retrievable answers with it.
    expect(await retrieve({ text: v1Only })).toEqual([]);
    // The query is a token that exists ONLY in v2. "gimnasio abre" is not usable
    // here: both articles match it in the lexical and trigram branches, the
    // fused scores tie to the last digit, and the winner would be decided by a
    // random UUID — a flake that says nothing about `is_current`.
    const current = await retrieve({ text: "enero" });
    expect(current[0]!.body).toBe(secondBody);
  });

  it("rejects malformed input rather than returning an empty list", async () => {
    await expect(retrieve({ text: "   " })).rejects.toBeInstanceOf(RangeError);
    await expect(
      // @ts-expect-error - scope is a closed set
      retrieve({ text: "spa", scope: "public" }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      retrieve({ text: "spa", embedding: [0.1, 0.2] }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      // @ts-expect-error - mode is a closed set
      retrieve({ text: "spa", mode: "fuzzy" }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("applies the property rule in resolve.ts without touching unrelated topics", () => {
    const hits = [
      { articleVersionId: randomUUID(), topicKey: "spa.hours", scope: "brand" as const },
      { articleVersionId: randomUUID(), topicKey: "spa.hours", scope: "property" as const },
      { articleVersionId: randomUUID(), topicKey: "wifi.access", scope: "brand" as const },
    ];
    expect(preferProperty(hits).map((hit) => [hit.topicKey, hit.scope])).toEqual([
      ["spa.hours", "property"],
      ["wifi.access", "brand"],
    ]);
    expect(resolveTopic(tenant, "spa.hours", hits).map((hit) => hit.scope)).toEqual(["property"]);
    expect(resolveTopic(tenant, "wifi.access", hits).map((hit) => hit.scope)).toEqual(["brand"]);
    expect(preferProperty([])).toEqual([]);
  });
});
