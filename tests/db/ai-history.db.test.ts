/**
 * S05-03 — "any historical answer reconstructable from the database".
 *
 * The case that matters is the one a year from now: an answer cited an article
 * version that has since been superseded twice. The reconstruction must return
 * the body AS CITED, and it must be impossible to read another tenant's run.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerMessage } from "../../src/ai/answer.ts";
import { AiRunNotFoundError, reconstructAnswer } from "../../src/ai/history.ts";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

let client: pg.Client;
let tenant: TenantContext;
let otherTenant: TenantContext;
let conversationId: string;
let v1: string;
let articleId: string;

const V1_BODY = "La alberca cierra a las 20:00 (horario de invierno).";
const V2_BODY = "La alberca cierra a las 21:00 (horario de verano).";

const runId = { value: "" };

function stubAi(citation: string) {
  const output = {
    decision: "answer",
    answer: "La alberca cierra a las 20:00.",
    language: "es-MX",
    citations: [{ article_version_id: citation, quote: "cierra a las 20:00" }],
    reason_code: null,
    topic_keys_used: ["pool.hours"],
    confidence: 0.9,
  };
  return withResilience(createFixedProvider(output, "stub-model-2026-01-01"), createFixedProvider(output, "stub-fb-2026-01-01"), {
    retries: 0,
    sleep: async () => {},
    now: () => 0,
  });
}

function asApp<T>(context: TenantContext, fn: (tx: pg.Client) => Promise<T>): Promise<T> {
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

describe("answer reconstruction (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const fixture = await seedTenant(client, "hist");
    tenant = { orgId: fixture.orgId, propertyId: fixture.propertyId };
    conversationId = fixture.conversationId;

    const other = await seedTenant(client, "hist_other");
    otherTenant = { orgId: other.orgId, propertyId: other.propertyId };

    await client.query("UPDATE properties SET settings = $1::jsonb WHERE property_id = $2", [
      JSON.stringify({ ...DEFAULT_SETTINGS, enabled_topics: ["pool.hours"] }),
      tenant.propertyId,
    ]);

    const created = await asApp(tenant, async (tx) => {
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'pool.hours', 'Alberca', 'es') RETURNING article_id`,
        [tenant.orgId, tenant.propertyId],
      );
      articleId = article.rows[0]!.article_id;
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, $4, $5::vector) RETURNING article_version_id`,
        [
          tenant.orgId,
          tenant.propertyId,
          articleId,
          V1_BODY,
          toVectorLiteral(stubEmbedding(V1_BODY)),
        ],
      );
      const id = version.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [id]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [tenant.orgId, tenant.propertyId, id, V1_BODY, toVectorLiteral(stubEmbedding(V1_BODY))],
      );
      return id;
    });
    v1 = created;

    const outcome = await asApp(tenant, (tx) =>
      answerMessage(
        tx,
        tenant,
        {
          conversationId,
          messageId: null,
          text: "¿A qué hora cierra la alberca?",
          language: "es",
          channel: "web",
        },
        { ai: stubAi(v1) },
      ),
    );
    if (outcome.kind !== "answer") throw new Error(`expected an answer, got ${outcome.kind}`);
    runId.value = outcome.aiRunId;
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("reconstructs model, prompt version, decision and the cited body", async () => {
    const answer = await asApp(tenant, (tx) => reconstructAnswer(tx, tenant, runId.value));
    expect(answer).toMatchObject({
      aiRunId: runId.value,
      conversationId,
      modelId: "stub-model-2026-01-01",
      promptVersion: "answer-v1",
      decision: "answer",
      reasonCode: null,
    });
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]).toMatchObject({
      articleVersionId: v1,
      body: V1_BODY,
      versionNo: 1,
      topicKey: "pool.hours",
      isCurrent: true,
    });
  });

  it("keeps citing the old body after the article is edited (AC-2)", async () => {
    // Publishing v2 is exactly what an editor does; v1's body cannot change.
    await asApp(tenant, async (tx) => {
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 2, false, $4, $5::vector) RETURNING article_version_id`,
        [
          tenant.orgId,
          tenant.propertyId,
          articleId,
          V2_BODY,
          toVectorLiteral(stubEmbedding(V2_BODY)),
        ],
      );
      await tx.query("SELECT promote_article_version($1)", [version.rows[0]!.article_version_id]);
    });

    const answer = await asApp(tenant, (tx) => reconstructAnswer(tx, tenant, runId.value));
    expect(answer.citations[0]!.body).toBe(V1_BODY);
    // The answer cited history: it is still reconstructable, and now honest
    // about the version no longer being current.
    expect(answer.citations[0]!.isCurrent).toBe(false);
    expect(answer.citations[0]!.versionNo).toBe(1);
  });

  it("refuses another tenant's run and an unknown id, without leaking existence", async () => {
    await expect(
      asApp(otherTenant, (tx) => reconstructAnswer(tx, otherTenant, runId.value)),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
    await expect(
      asApp(tenant, (tx) =>
        reconstructAnswer(tx, tenant, "00000000-0000-4000-8000-000000000000"),
      ),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
  });

  it("carries the conversation's handoff reasons with the run", async () => {
    await asApp(tenant, (tx) =>
      tx.query(
        `INSERT INTO handoff_reasons (org_id, property_id, conversation_id, reason_code, detail)
         VALUES ($1, $2, $3, 'guest_asked_human', 'guest typed "hablar con recepción"')`,
        [tenant.orgId, tenant.propertyId, conversationId],
      ),
    );
    const answer = await asApp(tenant, (tx) => reconstructAnswer(tx, tenant, runId.value));
    expect(answer.handoffs).toHaveLength(1);
    expect(answer.handoffs[0]).toMatchObject({ reasonCode: "guest_asked_human" });
  });

  it("has the indexes the reconstruction query needs (0014)", async () => {
    const indexes = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('ai_runs','citations')",
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain("ai_runs_property_time");
    expect(names).toContain("citations_run");
  });

  it("refuses a non-object usage blob at write time (0014 CHECK)", async () => {
    await expect(
      asApp(tenant, (tx) =>
        tx.query(
          `INSERT INTO ai_runs
             (org_id, property_id, conversation_id, model_id, prompt_version, decision, usage)
           VALUES ($1, $2, $3, 'stub-model-2026-01-01', 'answer-v1', 'no_answer', '[]'::jsonb)`,
          [tenant.orgId, tenant.propertyId, conversationId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
