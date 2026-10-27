/**
 * S11-05 / AC-1 — the three invariants against real rows.
 *
 * The fixture publishes through `promote_article_version()`, the product's own path,
 * rather than writing `is_current = true` — 0003 refuses that, and using the real
 * funnel is what proves invariant 2 is a live risk rather than a hypothetical: the
 * promote function flips the flag and leaves the old version's chunks exactly where
 * they were, which is precisely "a deleted policy, one publish too late".
 *
 * Invariant 3 cannot happen while the FK's ON DELETE CASCADE exists, so the test
 * lifts the constraint, writes the orphan, and puts it back — otherwise the assertion
 * would only be checking that a query returning nothing returns nothing.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileEmbeddings, EMBEDDING_INVARIANTS } from "../../src/knowledge/reconcile.ts";
import { counterTotal, resetCounters } from "../../src/metrics/counters.ts";
import type { TenantContext } from "../../src/db/tenant.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

let client: pg.Client;
let tenant: TenantContext;
let otherTenant: TenantContext;
let propertyId = "";

interface Article {
  articleId: string;
}

async function article(topic: string): Promise<Article> {
  const row = await client.query<{ article_id: string }>(
    `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title)
     VALUES ($1, $2, 'property', $3, $4) RETURNING article_id`,
    [tenant.orgId, tenant.propertyId, topic, topic],
  );
  return { articleId: row.rows[0]!.article_id };
}

async function version(
  target: Article,
  versionNo: number,
  body: string,
  chunks: string[],
): Promise<string> {
  const row = await client.query<{ article_version_id: string }>(
    `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body, embedding)
     VALUES ($1, $2, $3, $4, $5, array_fill(0.1::real, ARRAY[1536])::vector)
     RETURNING article_version_id`,
    [tenant.orgId, tenant.propertyId, target.articleId, versionNo, body],
  );
  const versionId = row.rows[0]!.article_version_id;
  for (const [ordinal, text] of chunks.entries()) {
    await client.query(
      `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
       VALUES ($1, $2, $3, $4, $5, array_fill(0.1::real, ARRAY[1536])::vector)`,
      [tenant.orgId, tenant.propertyId, versionId, ordinal, text],
    );
  }
  return versionId;
}

/** The product's publish path, under the caller's tenant context. */
async function promote(versionId: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenant.orgId]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [
      tenant.propertyId,
    ]);
    await client.query("SELECT promote_article_version($1)", [versionId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describe("embedding reconciliation (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    const seeded = await seedTenant(client, "reconcile");
    tenant = { orgId: seeded.orgId, propertyId: seeded.propertyId };
    propertyId = seeded.propertyId;
    const other = await seedTenant(client, "reconcile_other");
    otherTenant = { orgId: other.orgId, propertyId: other.propertyId };
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("passes a property whose live versions are chunked", async () => {
    resetCounters();
    const healthy = await article("pool-hours");
    const v1 = await version(healthy, 1, "The pool is open until 22:00.", ["pool until 22:00"]);
    await promote(v1);

    const result = await reconcileEmbeddings(client, tenant);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.byInvariant).toEqual({
      current_version_without_chunks: 0,
      chunk_on_non_current_version: 0,
      chunk_without_parent_version: 0,
    });
    expect(counterTotal("embedding_drift_total")).toBe(0);
  });

  it("catches a live version with no chunks — the article nobody can retrieve", async () => {
    resetCounters();
    const gap = await article("spa-menu");
    const v1 = await version(gap, 1, "The spa closes at 20:00.", []);
    await promote(v1);

    const result = await reconcileEmbeddings(client, tenant);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      invariant: "current_version_without_chunks",
      articleVersionId: v1,
      chunkId: null,
    });
    expect(result.ok).toBe(false);
    expect(counterTotal("embedding_drift_total")).toBe(1);
  });

  it("catches chunks left behind by a publish — the stale-policy case", async () => {
    resetCounters();
    const policy = await article("pet-policy");
    const oldVersion = await version(policy, 1, "Pets are welcome.", ["pets welcome"]);
    await promote(oldVersion);

    const newVersion = await version(policy, 2, "Pets are not allowed.", ["no pets"]);
    await promote(newVersion);

    const result = await reconcileEmbeddings(client, tenant);
    const stale = result.violations.filter(
      (violation) => violation.invariant === "chunk_on_non_current_version",
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ articleVersionId: oldVersion });
    expect(stale[0]!.chunkId).not.toBeNull();
    // The new version's chunk is current, so it is not reported.
    expect(
      result.violations.some((violation) => violation.articleVersionId === newVersion),
    ).toBe(false);
  });

  it("never repairs, however many violations it finds", async () => {
    const before = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM article_chunks WHERE property_id = $1",
      [propertyId],
    );
    const result = await reconcileEmbeddings(client, tenant);
    expect(result.violations.length).toBeGreaterThan(0);
    const after = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM article_chunks WHERE property_id = $1",
      [propertyId],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("does not report another property's drift against this one", async () => {
    const foreign = await article("foreign"); // tenant-scoped: this test's own property
    expect(foreign.articleId).not.toBe("");

    const otherResult = await reconcileEmbeddings(client, otherTenant);
    expect(otherResult.violations).toEqual([]);
    expect(otherResult.propertyId).toBe(otherTenant.propertyId);
  });

  it("catches an orphaned chunk when the cascade is not there to prevent one", async () => {
    const constraint = await client.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'article_chunks'::regclass AND contype = 'f'
          AND pg_get_constraintdef(oid) LIKE '%article_versions%'`,
    );
    const { conname, def } = constraint.rows[0]!;
    const dangling = "99999999-9999-5999-a999-999999999999";

    await client.query(`ALTER TABLE article_chunks DROP CONSTRAINT ${conname}`);
    try {
      await client.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body)
         VALUES ($1, $2, $3, 0, 'orphaned text')`,
        [tenant.orgId, tenant.propertyId, dangling],
      );
      resetCounters();
      const result = await reconcileEmbeddings(client, tenant);
      const orphans = result.violations.filter(
        (violation) => violation.invariant === "chunk_without_parent_version",
      );
      expect(orphans).toHaveLength(1);
      expect(orphans[0]!.articleVersionId).toBe(dangling);
      // The counter is cumulative within the run: this property already has two
      // standing violations from the tests above, and a reconciler that reported
      // only the newest one would under-report drift on every night it ran.
      expect(counterTotal("embedding_drift_total")).toBe(result.violations.length);
    } finally {
      await client.query("DELETE FROM article_chunks WHERE article_version_id = $1", [dangling]);
      await client.query(`ALTER TABLE article_chunks ADD CONSTRAINT ${conname} ${def}`);
    }
  });

  it("reports in the order the charter lists, so output is diffable run to run", async () => {
    const result = await reconcileEmbeddings(client, tenant);
    const order = result.violations.map((violation) => violation.invariant);
    const ranked = order.map((invariant) => EMBEDDING_INVARIANTS.indexOf(invariant));
    expect(ranked).toEqual([...ranked].sort((a, b) => a - b));
  });
});
