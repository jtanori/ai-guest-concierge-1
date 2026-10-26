/**
 * S04-03 — the fact short-circuit.
 *
 * Golden v1 row 1 is "¿A qué hora cierra la alberca?" and the correct answer is
 * `pool.hours` / `closing_time` out of `property_facts`, not a paragraph of
 * prose that a model has to re-read. This file pins that ordering:
 *
 *  - a verified fact answers, and retrieval is never consulted;
 *  - no fact means retrieval, not a guess;
 *  - a fact for a DIFFERENT key is not a near miss — it does not answer.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { resolveAnswerSource } from "../../src/knowledge/answer.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

let client: pg.Client;
let tenant: TenantContext;
let verifierUserId: string;

const POOL_BODY = "La alberca cierra a las 21:00. El acceso es con llave de la habitación.";

/** A verified fact, written the only way the schema allows: as the verifier role. */
async function insertVerifiedFact(input: {
  topicKey: string;
  factKey: string;
  value: string;
  unit: string;
  language: string;
  effectiveFrom: string;
}): Promise<void> {
  await withTenant(client, tenant, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    const row = await tx.query<{ fact_id: string }>(
      `INSERT INTO property_facts
         (org_id, property_id, topic_key, fact_key, fact_value, language, unit,
          effective_from, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
       RETURNING fact_id`,
      [
        tenant.orgId,
        tenant.propertyId,
        input.topicKey,
        input.factKey,
        input.value,
        input.language,
        input.unit,
        input.effectiveFrom,
      ],
    );
    // The BEFORE trigger only lets `concierge_fact_verifier` flip `verified`,
    // which is the same door verify_property_fact() uses.
    await tx.query("SET LOCAL ROLE concierge_fact_verifier");
    await tx.query(
      `UPDATE property_facts
          SET verified = true, verified_by = $1, verified_at = now()
        WHERE fact_id = $2`,
      [verifierUserId, row.rows[0]!.fact_id],
    );
  });
}

describe("answer source: fact before retrieval (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const org = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Answer', 'answer_org') RETURNING org_id",
    );
    const property = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Answer', 'answer_property') RETURNING property_id",
      [org.rows[0]!.org_id],
    );
    tenant = { orgId: org.rows[0]!.org_id, propertyId: property.rows[0]!.property_id };

    // `verified_by` is a real FK to users: a verifier id has to name someone.
    const user = await client.query<{ user_id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('verifier@example.test', 'Verifier') RETURNING user_id",
    );
    verifierUserId = user.rows[0]!.user_id;

    await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'pool.hours', 'Alberca', 'es')
         RETURNING article_id`,
        [tenant.orgId, tenant.propertyId],
      );
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, $4, $5::vector)
         RETURNING article_version_id`,
        [
          tenant.orgId,
          tenant.propertyId,
          article.rows[0]!.article_id,
          POOL_BODY,
          toVectorLiteral(stubEmbedding(POOL_BODY)),
        ],
      );
      const versionId = version.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [versionId]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [
          tenant.orgId,
          tenant.propertyId,
          versionId,
          POOL_BODY,
          toVectorLiteral(stubEmbedding(POOL_BODY)),
        ],
      );
    });

    await insertVerifiedFact({
      topicKey: "pool.hours",
      factKey: "closing_time",
      value: "20:00",
      unit: "time-of-day",
      language: "es",
      effectiveFrom: "2026-01-01",
    });
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("answers a structured hours question from the verified fact, not from prose", async () => {
    const source = await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      return resolveAnswerSource(tx, tenant, {
        text: "¿A qué hora cierra la alberca?",
        structured: { topicKey: "pool.hours", factKey: "closing_time", language: "es" },
      });
    });

    expect(source.kind).toBe("fact");
    if (source.kind !== "fact") throw new Error("unreachable");
    // The verified row, not the article body's 21:00.
    expect(source.fact).toEqual({ value: "20:00", unit: "time-of-day", effectiveFrom: "2026-01-01" });
  });

  it("falls back to retrieval when no verified fact covers the question", async () => {
    const source = await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      return resolveAnswerSource(tx, tenant, {
        text: "¿A qué hora cierra la alberca?",
        structured: { topicKey: "pool.hours", factKey: "opening_time", language: "es" },
      });
    });

    expect(source.kind).toBe("articles");
    if (source.kind !== "articles") throw new Error("unreachable");
    expect(source.hits[0]!.topicKey).toBe("pool.hours");
    expect(source.hits[0]!.scope).toBe("property");
    expect(source.hits[0]!.matchedChunk).toBeDefined();
  });

  it("does not answer a fact lookup in the wrong language from another language's row", async () => {
    const source = await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      return resolveAnswerSource(tx, tenant, {
        text: "What time does the pool close?",
        structured: { topicKey: "pool.hours", factKey: "closing_time", language: "en" },
      });
    });
    expect(source.kind).toBe("articles");
  });

  it("ignores a fact that is not yet effective", async () => {
    const source = await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      return resolveAnswerSource(tx, tenant, {
        text: "¿A qué hora cierra la alberca?",
        structured: {
          topicKey: "pool.hours",
          factKey: "closing_time",
          language: "es",
          on: "2025-06-01",
        },
      });
    });
    expect(source.kind).toBe("articles");
  });
});
