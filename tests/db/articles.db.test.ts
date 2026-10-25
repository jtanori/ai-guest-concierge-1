/**
 * S03-01 - article authoring + immutable versioning under RLS.
 *
 * The AC's shape is literal: an edit appends a new row and leaves the old body
 * untouched. Publishing is S04-01's job, so new versions stay retired here;
 * one test promotes through S02-05's primitive only to prove `listArticles`
 * reports the current version correctly.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditWriteError } from "../../src/audit/write.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import {
  ArticleNotFoundError,
  ArticleSourceNotFoundError,
  ArticleTopicConflictError,
  ArticleValidationError,
  ArticleVersionNotFoundError,
  createArticle,
  editArticle,
  getVersion,
  listArticles,
  listVersions,
  type ArticleDraft,
} from "../../src/knowledge/articles.ts";
import { reembedAndPublish } from "../../src/knowledge/reembed.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

let client: pg.Client;
let tenantA: TenantContext;
let tenantB: TenantContext;
let actorA: { userId: string };
let actorB: { userId: string };
let sourceA: string;
let sourceB: string;

function draft(overrides: Partial<ArticleDraft> = {}): ArticleDraft {
  return {
    topicKey: "pool.hours",
    title: "Pool hours",
    body: "The pool is open 07:00-21:00.",
    language: "en",
    sourceId: sourceA,
    ...overrides,
  };
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

async function auditRows(propertyId: string): Promise<
  Array<{ action: string; entity_type: string; entity_id: string; detail: Record<string, unknown> }>
> {
  const result = await client.query<{
    action: string;
    entity_type: string;
    entity_id: string;
    detail: Record<string, unknown>;
  }>(
    `SELECT action, entity_type, entity_id, detail
       FROM audit_log
      WHERE property_id = $1
      ORDER BY audit_id`,
    [propertyId],
  );
  return result.rows;
}

describe("article editor + immutable versioning (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const orgA = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Articles A', 'articles_a') RETURNING org_id",
    );
    const orgB = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Articles B', 'articles_b') RETURNING org_id",
    );
    const propertyA = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Articles A', 'articles_property_a') RETURNING property_id",
      [orgA.rows[0]!.org_id],
    );
    const propertyB = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Articles B', 'articles_property_b') RETURNING property_id",
      [orgB.rows[0]!.org_id],
    );

    tenantA = { orgId: orgA.rows[0]!.org_id, propertyId: propertyA.rows[0]!.property_id };
    tenantB = { orgId: orgB.rows[0]!.org_id, propertyId: propertyB.rows[0]!.property_id };

    const userA = await client.query<{ user_id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('articles-a@example.mx', 'Author A') RETURNING user_id",
    );
    const userB = await client.query<{ user_id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('articles-b@example.mx', 'Author B') RETURNING user_id",
    );
    actorA = { userId: userA.rows[0]!.user_id };
    actorB = { userId: userB.rows[0]!.user_id };

    sourceA = await asApp(tenantA, async (tx) => {
      const row = await tx.query<{ source_id: string }>(
        `INSERT INTO knowledge_sources (org_id, property_id, kind, title)
         VALUES ($1, $2, 'manual', 'Property A manual')
         RETURNING source_id`,
        [tenantA.orgId, tenantA.propertyId],
      );
      return row.rows[0]!.source_id;
    });
    sourceB = await asApp(tenantB, async (tx) => {
      const row = await tx.query<{ source_id: string }>(
        `INSERT INTO knowledge_sources (org_id, property_id, kind, title)
         VALUES ($1, $2, 'manual', 'Property B manual')
         RETURNING source_id`,
        [tenantB.orgId, tenantB.propertyId],
      );
      return row.rows[0]!.source_id;
    });
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("creates an article and a retired version 1, with an audit row", async () => {
    const created = await asApp(tenantA, (tx) =>
      createArticle(tx, tenantA, actorA, draft()),
    );
    expect(created.versionNo).toBe(1);

    const detail = await asApp(tenantA, (tx) =>
      getVersion(tx, tenantA, created.articleVersionId),
    );
    expect(detail).toMatchObject({
      articleId: created.articleId,
      articleVersionId: created.articleVersionId,
      topicKey: "pool.hours",
      title: "Pool hours",
      body: "The pool is open 07:00-21:00.",
      language: "en",
      sourceId: sourceA,
      versionNo: 1,
      isCurrent: false,
      promotedAt: null,
    });

    const article = await client.query<{ scope: string; title: string; language: string }>(
      "SELECT scope, title, language FROM knowledge_articles WHERE article_id = $1",
      [created.articleId],
    );
    expect(article.rows[0]).toEqual({
      scope: "property",
      title: "Pool hours",
      language: "en",
    });

    const audits = await auditRows(tenantA.propertyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "article.version_created",
      entity_type: "article_version",
      entity_id: created.articleVersionId,
      detail: {
        topic_key: "pool.hours",
        version_no: 1,
        has_text: true,
        language: "en",
      },
    });
  });

  it("refuses a duplicate property-scope topic without creating a version", async () => {
    await expect(
      asApp(tenantA, (tx) => createArticle(tx, tenantA, actorA, draft())),
    ).rejects.toBeInstanceOf(ArticleTopicConflictError);

    const count = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM knowledge_articles WHERE property_id = $1",
      [tenantA.propertyId],
    );
    expect(count.rows[0]!.count).toBe("1");
  });

  it("appends a new version on body edit and leaves the old body untouched", async () => {
    const created = await asApp(tenantA, (tx) =>
      createArticle(
        tx,
        tenantA,
        actorA,
        draft({ topicKey: "spa.services", title: "Spa", body: "Spa old hours." }),
      ),
    );
    const edited = await asApp(tenantA, (tx) =>
      editArticle(
        tx,
        tenantA,
        actorA,
        created.articleId,
        draft({
          topicKey: "spa.services",
          title: "Spa",
          body: "The spa is open 09:00-20:00.",
        }),
      ),
    );
    expect(edited).toMatchObject({ versionNo: 2, created: true });
    expect(edited.articleVersionId).not.toBe(created.articleVersionId);

    const oldVersion = await asApp(tenantA, (tx) =>
      getVersion(tx, tenantA, created.articleVersionId),
    );
    expect(oldVersion.body).toBe("Spa old hours.");
    expect(oldVersion.isCurrent).toBe(false);

    const versions = await asApp(tenantA, (tx) =>
      listVersions(tx, tenantA, created.articleId),
    );
    expect(versions.map((row) => row.versionNo)).toEqual([2, 1]);
    expect(versions.every((row) => row.isCurrent === false)).toBe(true);
    expect(versions[0]!.bodyPreview).toBe("The spa is open 09:00-20:00.");

    const articles = await asApp(tenantA, (tx) => listArticles(tx, tenantA));
    const spa = articles.find((row) => row.articleId === created.articleId);
    expect(spa).toMatchObject({
      topicKey: "spa.services",
      versionCount: 2,
      currentVersionId: null,
      currentVersionNo: null,
    });
  });

  it("treats an identical edit as a no-op (no version, no audit)", async () => {
    const created = await asApp(tenantA, (tx) =>
      createArticle(tx, tenantA, actorA, draft({ topicKey: "gym.hours", title: "Gym" })),
    );
    const before = (await auditRows(tenantA.propertyId)).length;

    const edited = await asApp(tenantA, (tx) =>
      editArticle(
        tx,
        tenantA,
        actorA,
        created.articleId,
        draft({ topicKey: "gym.hours", title: "Gym" }),
      ),
    );
    expect(edited).toEqual({
      articleVersionId: created.articleVersionId,
      versionNo: 1,
      created: false,
    });
    expect(await auditRows(tenantA.propertyId)).toHaveLength(before);

    const versions = await asApp(tenantA, (tx) =>
      listVersions(tx, tenantA, created.articleId),
    );
    expect(versions).toHaveLength(1);
  });

  it("updates title metadata without appending a version", async () => {
    const created = await asApp(tenantA, (tx) =>
      createArticle(tx, tenantA, actorA, draft({ topicKey: "dining.menu", title: "Menu" })),
    );
    const edited = await asApp(tenantA, (tx) =>
      editArticle(
        tx,
        tenantA,
        actorA,
        created.articleId,
        draft({ topicKey: "dining.menu", title: "Dinner menu" }),
      ),
    );
    expect(edited).toMatchObject({
      articleVersionId: created.articleVersionId,
      versionNo: 1,
      created: false,
    });

    const detail = await asApp(tenantA, (tx) =>
      getVersion(tx, tenantA, created.articleVersionId),
    );
    expect(detail.title).toBe("Dinner menu");
    expect(
      (await asApp(tenantA, (tx) => listVersions(tx, tenantA, created.articleId))).length,
    ).toBe(1);

    const audits = await auditRows(tenantA.propertyId);
    expect(audits.at(-1)).toMatchObject({
      action: "article.updated",
      entity_type: "article",
      entity_id: created.articleId,
      detail: { changed: ["title"] },
    });
  });

  it("preserves an omitted source on edit and clears it only when explicitly null", async () => {
    const created = await asApp(tenantA, (tx) =>
      createArticle(tx, tenantA, actorA, draft({ topicKey: "policy.quiet", title: "Quiet" })),
    );

    await asApp(tenantA, (tx) =>
      editArticle(
        tx,
        tenantA,
        actorA,
        created.articleId,
        draft({ topicKey: "policy.quiet", title: "Quiet", sourceId: undefined }),
      ),
    );
    expect(
      (await asApp(tenantA, (tx) => getVersion(tx, tenantA, created.articleVersionId))).sourceId,
    ).toBe(sourceA);

    await asApp(tenantA, (tx) =>
      editArticle(
        tx,
        tenantA,
        actorA,
        created.articleId,
        draft({ topicKey: "policy.quiet", title: "Quiet", sourceId: null }),
      ),
    );
    expect(
      (await asApp(tenantA, (tx) => getVersion(tx, tenantA, created.articleVersionId))).sourceId,
    ).toBeNull();
  });

  it("supports a picture-only body (null) and reports it in the version summary", async () => {
    const created = await asApp(tenantA, (tx) =>
      createArticle(
        tx,
        tenantA,
        actorA,
        draft({ topicKey: "policy.parking", title: "Parking", body: null }),
      ),
    );
    const detail = await asApp(tenantA, (tx) =>
      getVersion(tx, tenantA, created.articleVersionId),
    );
    expect(detail.body).toBeNull();
    expect(detail.bodyLength).toBeNull();
    expect(detail.bodyPreview).toBeNull();

    const audits = await auditRows(tenantA.propertyId);
    expect(audits.at(-1)!.detail).toMatchObject({ has_text: false });
  });

  it("reports the current version after S04's publish primitive runs", async () => {
    const created = await asApp(tenantA, (tx) =>
      createArticle(tx, tenantA, actorA, draft({ topicKey: "wifi.access", title: "Wi-Fi" })),
    );
    const edited = await asApp(tenantA, (tx) =>
      editArticle(
        tx,
        tenantA,
        actorA,
        created.articleId,
        draft({
          topicKey: "wifi.access",
          title: "Wi-Fi",
          body: "Network: GuestPlus.",
        }),
      ),
    );
    await asApp(tenantA, (tx) =>
      reembedAndPublish(tx, tenantA, edited.articleVersionId, async (text) =>
        stubEmbedding(text),
      ),
    );

    const articles = await asApp(tenantA, (tx) => listArticles(tx, tenantA));
    const wifi = articles.find((row) => row.articleId === created.articleId);
    expect(wifi).toMatchObject({
      currentVersionId: edited.articleVersionId,
      currentVersionNo: 2,
      versionCount: 2,
    });
    expect(
      (await asApp(tenantA, (tx) => getVersion(tx, tenantA, edited.articleVersionId))).isCurrent,
    ).toBe(true);
  });

  it("hides foreign articles/versions and refuses foreign sources", async () => {
    const created = await asApp(tenantA, (tx) =>
      createArticle(tx, tenantA, actorA, draft({ topicKey: "events.wedding", title: "Wedding" })),
    );

    await expect(
      asApp(tenantB, (tx) =>
        editArticle(
          tx,
          tenantB,
          actorB,
          created.articleId,
          draft({ topicKey: "events.wedding", title: "Wedding" }),
        ),
      ),
    ).rejects.toBeInstanceOf(ArticleNotFoundError);
    await expect(
      asApp(tenantB, (tx) => getVersion(tx, tenantB, created.articleVersionId)),
    ).rejects.toBeInstanceOf(ArticleVersionNotFoundError);
    await expect(
      asApp(tenantB, (tx) => listVersions(tx, tenantB, created.articleId)),
    ).rejects.toBeInstanceOf(ArticleNotFoundError);
    expect(await asApp(tenantB, (tx) => listArticles(tx, tenantB))).toEqual([]);

    await expect(
      asApp(tenantA, (tx) =>
        createArticle(
          tx,
          tenantA,
          actorA,
          draft({ topicKey: "events.conference", title: "Conference", sourceId: sourceB }),
        ),
      ),
    ).rejects.toBeInstanceOf(ArticleSourceNotFoundError);
  });

  it("refuses changing an article's topic_key", async () => {
    const created = await asApp(tenantA, (tx) =>
      createArticle(tx, tenantA, actorA, draft({ topicKey: "events.birthday", title: "Birthday" })),
    );
    await expect(
      asApp(tenantA, (tx) =>
        editArticle(
          tx,
          tenantA,
          actorA,
          created.articleId,
          draft({ topicKey: "events.anniversary", title: "Birthday" }),
        ),
      ),
    ).rejects.toBeInstanceOf(ArticleValidationError);
  });

  it("keeps brand-scope articles out of the property authoring surface", async () => {
    const brand = await asApp(tenantA, async (tx) => {
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles
           (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'brand', 'brand.only', 'Brand only', 'en')
         RETURNING article_id`,
        [tenantA.orgId, tenantA.propertyId],
      );
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, body)
         VALUES ($1, $2, $3, 1, 'Brand scope body.')
         RETURNING article_version_id`,
        [tenantA.orgId, tenantA.propertyId, article.rows[0]!.article_id],
      );
      return {
        articleId: article.rows[0]!.article_id,
        articleVersionId: version.rows[0]!.article_version_id,
      };
    });

    expect(
      (await asApp(tenantA, (tx) => listArticles(tx, tenantA))).some(
        (row) => row.articleId === brand.articleId,
      ),
    ).toBe(false);
    await expect(
      asApp(tenantA, (tx) => getVersion(tx, tenantA, brand.articleVersionId)),
    ).rejects.toBeInstanceOf(ArticleVersionNotFoundError);
    await expect(
      asApp(tenantA, (tx) =>
        editArticle(
          tx,
          tenantA,
          actorA,
          brand.articleId,
          draft({ topicKey: "brand.only", title: "Brand only" }),
        ),
      ),
    ).rejects.toBeInstanceOf(ArticleNotFoundError);
  });

  it("rolls the article + version back when the audit write fails", async () => {
    await expect(
      asApp(tenantA, (tx) =>
        createArticle(
          tx,
          tenantA,
          { userId: "not-a-uuid" },
          draft({ topicKey: "events.rollback", title: "Rollback" }),
        ),
      ),
    ).rejects.toBeInstanceOf(AuditWriteError);

    const article = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM knowledge_articles WHERE property_id = $1 AND topic_key = 'events.rollback'",
      [tenantA.propertyId],
    );
    const versions = await client.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM article_versions av
         JOIN knowledge_articles ka
           ON ka.article_id = av.article_id
          AND ka.org_id = av.org_id
          AND ka.property_id = av.property_id
        WHERE av.property_id = $1 AND ka.topic_key = 'events.rollback'`,
      [tenantA.propertyId],
    );
    expect(article.rows[0]!.count).toBe("0");
    expect(versions.rows[0]!.count).toBe("0");
  });
});
