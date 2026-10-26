/**
 * S05-01 — AC-3 ("every call writes ai_runs") and the reject-never-send rule,
 * proven against a real database.
 *
 * The cases follow the pipeline in `src/ai/answer.ts` order: policy, facts,
 * retrieval, generate, validate, persist. The provider is a stub, so the tests
 * own what the "model" returns — including the malformed answers the contract
 * must reject.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerMessage } from "../../src/ai/answer.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { withResilience } from "../../src/ai/provider.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

let client: pg.Client;
let tenant: TenantContext;
let conversationId: string;
let versionId: string;
let verifierUserId: string;

const BODY = "La alberca cierra a las 20:00 y el acceso es con llave de la habitación.";
const MODEL = "stub-model-2026-01-01";

function validAnswer(citation: string) {
  return {
    decision: "answer",
    answer: "La alberca cierra a las 20:00.",
    language: "es-MX",
    citations: [{ article_version_id: citation, quote: "cierra a las 20:00" }],
    reason_code: null,
    topic_keys_used: ["pool.hours"],
    confidence: 0.88,
  };
}

/** A deterministic ResilientAi: stub primary, stub fallback, no sleeping. */
function ai(output: unknown) {
  return withResilience(createFixedProvider(output, MODEL), createFixedProvider(output, `${MODEL}-fb`), {
    retries: 0,
    sleep: async () => {},
    now: () => 0,
  });
}

function asApp<T>(fn: (tx: pg.Client) => Promise<T>): Promise<T> {
  return withTenant(client, tenant, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

function ask(output: unknown, overrides: Record<string, unknown> = {}) {
  return asApp((tx) =>
    answerMessage(
      tx,
      tenant,
      {
        conversationId,
        messageId: null,
        text: "¿A qué hora cierra la alberca?",
        language: "es",
        channel: "web",
        ...overrides,
      },
      { ai: ai(output) },
    ),
  );
}

describe("AI pipeline + ai_runs (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    const fixture = await seedTenant(client, "ai");
    tenant = { orgId: fixture.orgId, propertyId: fixture.propertyId };
    conversationId = fixture.conversationId;

    // property_facts.verified_by is a real FK: a verifier has to be someone.
    const user = await client.query<{ user_id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('verifier@ai.test', 'Verifier') RETURNING user_id",
    );
    verifierUserId = user.rows[0]!.user_id;

    // A published, chunked article so hybrid retrieval has something to return.
    const created = await asApp(async (tx) => {
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'pool.hours', 'Alberca', 'es') RETURNING article_id`,
        [tenant.orgId, tenant.propertyId],
      );
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, $4, $5::vector) RETURNING article_version_id`,
        [
          tenant.orgId,
          tenant.propertyId,
          article.rows[0]!.article_id,
          BODY,
          toVectorLiteral(stubEmbedding(BODY)),
        ],
      );
      const id = version.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [id]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [tenant.orgId, tenant.propertyId, id, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
      return id;
    });
    versionId = created;

    // Topic-scoped AI is only switched on for topics the property enabled.
    // Settings are a complete object (0013): the CHECK validates every key.
    await client.query("UPDATE properties SET settings = $1::jsonb WHERE property_id = $2", [
      JSON.stringify({ ...DEFAULT_SETTINGS, enabled_topics: ["pool.hours"] }),
      tenant.propertyId,
    ]);
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("writes one ai_runs row per call, with the pinned model and prompt version", async () => {
    const outcome = await ask(validAnswer(versionId));
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") throw new Error("unreachable");

    const runs = await client.query<{
      ai_run_id: string;
      model_id: string;
      prompt_version: string;
      decision: string;
      confidence: string | null;
      conversation_id: string;
    }>("SELECT * FROM ai_runs WHERE conversation_id = $1", [conversationId]);
    expect(runs.rowCount).toBe(1);
    expect(runs.rows[0]).toMatchObject({
      ai_run_id: outcome.aiRunId,
      model_id: MODEL,
      prompt_version: "answer-v1",
      decision: "answer",
      conversation_id: conversationId,
    });
    expect(Number(runs.rows[0]!.confidence)).toBeCloseTo(0.88, 2);

    const citations = await client.query<{ article_version_id: string }>(
      "SELECT article_version_id FROM citations WHERE ai_run_id = $1",
      [outcome.aiRunId],
    );
    expect(citations.rows.map((r) => r.article_version_id)).toEqual([versionId]);

    const events = await client.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE conversation_id = $1 ORDER BY event_id",
      [conversationId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(["ai_run_completed", "ai_answer_sent"]);
  });

  it("rejects malformed output, escalates, and still records the call", async () => {
    const before = await client.query("SELECT 1 FROM ai_runs");
    const outcome = await ask("Sure! The pool closes at 20:00.");
    expect(outcome.kind).toBe("escalate");
    if (outcome.kind !== "escalate") throw new Error("unreachable");
    expect(outcome.detail).toBe("contract_violation");
    expect(outcome.aiRunId).not.toBeNull();

    const run = await client.query<{
      decision: string;
      usage: { contract_violations?: number; violations?: string[] };
    }>(
      "SELECT decision, usage FROM ai_runs WHERE ai_run_id = $1",
      [outcome.aiRunId],
    );
    expect(run.rows[0]!.decision).toBe("escalate");
    expect(run.rows[0]!.usage.contract_violations).toBeGreaterThan(0);
    expect(run.rows[0]!.usage.violations?.length).toBeGreaterThan(0);

    // Nothing was sent, so nothing was cited.
    const citations = await client.query("SELECT 1 FROM citations WHERE ai_run_id = $1", [
      outcome.aiRunId,
    ]);
    expect(citations.rowCount).toBe(0);
    // The row count grew by exactly one — the rejected call is still auditable.
    const after = await client.query("SELECT 1 FROM ai_runs");
    expect(after.rowCount! - before.rowCount!).toBe(1);
  });

  it("rejects a citation the retrieval never returned", async () => {
    const stranger = "99999999-9999-4999-8999-999999999999";
    const outcome = await ask(validAnswer(stranger));
    expect(outcome.kind).toBe("escalate");
    if (outcome.kind !== "escalate") throw new Error("unreachable");
    expect(outcome.detail).toBe("contract_violation");
  });

  it("escalates on policy before ever calling the model", async () => {
    await client.query("UPDATE properties SET ai_mode = 'human_only' WHERE property_id = $1", [
      tenant.propertyId,
    ]);
    const before = await client.query("SELECT 1 FROM ai_runs");
    const outcome = await ask(validAnswer(versionId));
    expect(outcome).toMatchObject({ kind: "escalate", detail: "mode_human_only" });
    if (outcome.kind !== "escalate") throw new Error("unreachable");
    expect(outcome.aiRunId).toBeNull();
    const after = await client.query("SELECT 1 FROM ai_runs");
    expect(after.rowCount).toBe(before.rowCount);
    await client.query("UPDATE properties SET ai_mode = 'auto' WHERE property_id = $1", [
      tenant.propertyId,
    ]);
  });

  it("escalates a topic the property has not enabled", async () => {
    const outcome = await ask(validAnswer(versionId), { topicKey: "spa.hours" });
    expect(outcome).toMatchObject({ kind: "escalate", detail: "topic_disabled" });
  });

  it("emits no_answer instead of calling the model when nothing was retrieved", async () => {
    const before = await client.query("SELECT 1 FROM ai_runs");
    const outcome = await ask(validAnswer(versionId), {
      // No token and no trigram in the corpus: the retrieve-gate's only
      // honest trigger until S06-03 calibrates a score cutoff.
      text: "xyzzyqqq",
    });
    expect(outcome).toMatchObject({ kind: "no_answer", reasonCode: "low_retrieval" });
    const after = await client.query("SELECT 1 FROM ai_runs");
    expect(after.rowCount).toBe(before.rowCount);
  });

  it("answers from a verified fact without a model call or an ai_run", async () => {
    const fact = await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      const inserted = await tx.query<{ fact_id: string }>(
        `INSERT INTO property_facts
           (org_id, property_id, topic_key, fact_key, fact_value, language, unit,
            effective_from, verified)
         VALUES ($1, $2, 'pool.hours', 'closing_time', '20:00', 'es', 'time-of-day',
                 '2026-01-01', false)
         RETURNING fact_id`,
        [tenant.orgId, tenant.propertyId],
      );
      await tx.query("SET LOCAL ROLE concierge_fact_verifier");
      await tx.query(
        `UPDATE property_facts SET verified = true, verified_by = $1, verified_at = now()
          WHERE fact_id = $2`,
        [verifierUserId, inserted.rows[0]!.fact_id],
      );
      return inserted.rows[0]!.fact_id;
    });
    expect(fact).toBeDefined();

    const before = await client.query("SELECT 1 FROM ai_runs");
    const outcome = await ask(validAnswer(versionId), {
      structured: { topicKey: "pool.hours", factKey: "closing_time", language: "es" },
    });
    expect(outcome.kind).toBe("fact");
    if (outcome.kind !== "fact") throw new Error("unreachable");
    expect(outcome.fact.value).toBe("20:00");
    const after = await client.query("SELECT 1 FROM ai_runs");
    expect(after.rowCount).toBe(before.rowCount);
  });

  it("refuses a citation that names an article id instead of a version id (D5)", async () => {
    // The contract only ever accepts version ids; the FK is the second wall.
    const outcome = await ask(validAnswer("44444444-4444-4444-8444-444444444444"));
    expect(outcome.kind).toBe("escalate");
  });
});
