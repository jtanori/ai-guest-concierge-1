/**
 * S06A-01 — the eval-only stage observer, proven against the real pipeline.
 *
 * The harness tests pin what the diagnostic *does* with stage provenance; this
 * file pins that the pipeline actually emits it, in order, with the right
 * stage — and that emitting it changes nothing else: same outcomes, same
 * persistence, same tenant behaviour, and nothing in the trace that could not
 * go into a GitHub Actions artifact.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerMessage,
  type AnswerMessageInput,
  type AnswerStageEvent,
  type AnswerStageObserver,
} from "../../src/ai/answer.ts";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider, createScriptedProvider } from "../../src/ai/stub.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { createFact, verifyFact } from "../../src/knowledge/facts.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const MODEL = "trace-model-2026-01-01";
const BODY = "La alberca cierra a las 20:00 y el acceso es con llave de la habitacion.";
const QUESTION = "¿A qué hora cierra la alberca?";

let client: pg.Client;
let tenant: TenantContext;
let emptyTenant: TenantContext;
let conversationId: string;
let emptyConversationId: string;
let actorUserId: string;
let versionId: string;

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

function healthyAi() {
  return withResilience(
    createFixedProvider(validAnswer(versionId), MODEL),
    createFixedProvider(validAnswer(versionId), `${MODEL}-fallback`),
    { retries: 0, sleep: async () => {}, now: () => 0 },
  );
}

/** Both providers down, with the production error class both of them throw. */
function downAi() {
  return withResilience(
    createScriptedProvider([new Error("primary down")], "trace-primary-down"),
    createScriptedProvider([new Error("fallback down")], "trace-fallback-down"),
    { retries: 0, sleep: async () => {}, now: () => 0 },
  );
}

interface AskOptions {
  input?: Partial<AnswerMessageInput>;
  onStage?: AnswerStageObserver;
  ai?: ReturnType<typeof withResilience>;
  context?: TenantContext;
  conversation?: string;
}

async function ask(text: string, options: AskOptions = {}) {
  const context = options.context ?? tenant;
  const conversation = options.conversation ?? conversationId;
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return answerMessage(
      tx,
      context,
      {
        conversationId: conversation,
        messageId: null,
        text,
        language: "es",
        channel: "web",
        ...(options.input ?? {}),
      },
      {
        ai: options.ai ?? healthyAi(),
        ...(options.onStage === undefined ? {} : { onStage: options.onStage }),
      },
    );
  });
}

function collect(): { observer: AnswerStageObserver; events: AnswerStageEvent[] } {
  const events: AnswerStageEvent[] = [];
  return { observer: (event) => { events.push(event); }, events };
}

const stagesOf = (events: readonly AnswerStageEvent[]): string[] =>
  events.map((event) => event.stage);

describe("eval stage observer (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const withArticles = await seedTenant(client, "trace");
    tenant = { orgId: withArticles.orgId, propertyId: withArticles.propertyId };
    conversationId = withArticles.conversationId;

    // A second property with NO articles: the only way to guarantee a run whose
    // retrieval really came back empty, rather than one that happened to match.
    const withoutArticles = await seedTenant(client, "traceempty");
    emptyTenant = { orgId: withoutArticles.orgId, propertyId: withoutArticles.propertyId };
    emptyConversationId = withoutArticles.conversationId;

    for (const propertyId of [tenant.propertyId, emptyTenant.propertyId]) {
      await client.query("UPDATE properties SET settings = $1::jsonb WHERE property_id = $2", [
        JSON.stringify(DEFAULT_SETTINGS),
        propertyId,
      ]);
    }

    // `settings` is a complete object (0013) and the fact service binds writes
    // to the session user, so the actor has to exist and be a member.
    const user = await client.query<{ user_id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('trace@concierge.test', 'Trace') RETURNING user_id",
    );
    actorUserId = user.rows[0]!.user_id;
    await client.query(
      "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 1)",
      [actorUserId, tenant.propertyId],
    );

    // One published, chunked article, so retrieval has exactly one candidate.
    const created = await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
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

    // One VERIFIED fact, so the fact stage has something to hit. Verified
    // through the service (never raw SQL): `verified` is not app-writable.
    await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      await tx.query("SELECT set_config('app.current_user_id', $1, true)", [actorUserId]);
      const actor = { userId: actorUserId };
      const fact = await createFact(tx, tenant, actor, {
        topicKey: "pool.hours",
        factKey: "closing_time",
        value: "20:00",
        unit: "time-of-day",
        language: "es",
        effectiveFrom: "2026-01-01",
      });
      await verifyFact(tx, tenant, actor, fact.factId);
    });
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("records a pre-retrieval guardrail and never reaches retrieval", async () => {
    const { observer, events } = collect();
    const outcome = await ask("Quiero un reembolso por la noche de anoche", { onStage: observer });

    expect(outcome.kind).toBe("escalate");
    expect(stagesOf(events)).toEqual(["policy", "sensitive"]);
    expect(events[1]).toMatchObject({
      stage: "sensitive",
      status: "stop",
      reasonCode: "sensitive_topic",
      detail: "sensitive:money_and_refunds",
    });
    expect(events.some((event) => event.stage === "retrieval")).toBe(false);
  });

  it("records a verified fact as its own stage and stops before retrieval", async () => {
    const { observer, events } = collect();
    const outcome = await ask(QUESTION, {
      onStage: observer,
      input: { structured: { topicKey: "pool.hours", factKey: "closing_time", language: "es" } },
    });

    expect(outcome.kind).toBe("fact");
    expect(stagesOf(events)).toEqual(["policy", "sensitive", "facts"]);
    expect(events[2]).toMatchObject({
      stage: "facts",
      status: "ok",
      detail: "hit",
      topicKey: "pool.hours",
      factKey: "closing_time",
    });
  });

  it("records a fact miss and still runs retrieval after it", async () => {
    const { observer, events } = collect();
    await ask(QUESTION, {
      onStage: observer,
      input: { structured: { topicKey: "pool.hours", factKey: "no_such_key", language: "es" } },
    });

    expect(stagesOf(events)).toEqual([
      "policy",
      "sensitive",
      "facts",
      "retrieval",
      "generate",
      "contract",
      "guardrail",
    ]);
    expect(events[2]).toMatchObject({ stage: "facts", status: "ok", detail: "miss" });
    expect(events[3]).toMatchObject({ stage: "retrieval", status: "ok" });
    expect(events[3]!.count).toBeGreaterThanOrEqual(1);
    expect(events[3]!.topics).toEqual(["pool.hours"]);
    expect(events[3]!.articleVersionIds).toContain(versionId);
  });

  it("records every stage of an answered question, with ids and counts only", async () => {
    const { observer, events } = collect();
    const outcome = await ask(QUESTION, { onStage: observer });

    expect(outcome.kind).toBe("answer");
    expect(stagesOf(events)).toEqual([
      "policy",
      "sensitive",
      "facts",
      "retrieval",
      "generate",
      "contract",
      "guardrail",
    ]);
    expect(events[0]).toMatchObject({ stage: "policy", status: "ok" });
    expect(events[1]).toMatchObject({ stage: "sensitive", status: "ok" });
    expect(events[2]).toMatchObject({ stage: "facts", status: "skip" });
    expect(events[3]).toMatchObject({
      stage: "retrieval",
      status: "ok",
      topics: ["pool.hours"],
    });
    expect(events[3]!.count).toBeGreaterThanOrEqual(1);
    expect(events[3]!.articleVersionIds).toContain(versionId);
    expect(events[4]).toMatchObject({
      stage: "generate",
      status: "ok",
      modelId: MODEL,
      usedFallback: false,
    });
    expect(events[6]).toMatchObject({ stage: "guardrail", status: "ok" });
  });

  it("records a genuinely empty retrieval as retrieval ok with zero candidates", async () => {
    const { observer, events } = collect();
    const outcome = await ask("¿Cuál es el wifi de la habitación?", {
      onStage: observer,
      context: emptyTenant,
      conversation: emptyConversationId,
    });

    expect(outcome.kind).toBe("no_answer");
    expect(stagesOf(events)).toEqual(["policy", "sensitive", "facts", "retrieval"]);
    expect(events[3]).toMatchObject({
      stage: "retrieval",
      status: "ok",
      count: 0,
      topics: [],
      articleVersionIds: [],
    });
    // Nothing to generate from, so no model was ever consulted.
    expect(events.some((event) => event.stage === "generate")).toBe(false);
  });

  it("records a provider outage at the generate stage, without the adapter message", async () => {
    const { observer, events } = collect();
    const outcome = await ask(QUESTION, { onStage: observer, ai: downAi() });

    expect(outcome.kind).toBe("unavailable");
    expect(events.at(-1)).toMatchObject({
      stage: "generate",
      status: "error",
      reasonCode: "provider_unavailable",
    });
    // The adapter's own words are not stage evidence and must not travel.
    expect(JSON.stringify(events)).not.toContain("primary down");
    expect(JSON.stringify(events)).not.toContain("fallback down");
  });

  it("emits no guest text, prompt, article body or DSN in the trace", async () => {
    const { observer, events } = collect();
    await ask(QUESTION, { onStage: observer });
    const serialised = JSON.stringify(events);

    expect(serialised).not.toContain(QUESTION);
    expect(serialised).not.toContain("¿A qué hora");
    expect(serialised).not.toContain(BODY);
    expect(serialised).not.toContain("La alberca cierra a las 20:00.");
    expect(serialised).not.toContain("postgres://");
    expect(serialised).not.toContain("system");
    // Only our vocabulary: stage names, status words, reason codes, ids.
    for (const event of events) {
      expect(event.stage).toMatch(/^[a-z]+$/);
      expect(["ok", "skip", "stop", "error"]).toContain(event.status);
    }
  });

  it("changes nothing when no observer is passed", async () => {
    const countRuns = async (): Promise<number> => {
      const rows = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM ai_runs WHERE conversation_id = $1",
        [conversationId],
      );
      return Number(rows.rows[0]!.n);
    };

    const before = await countRuns();
    const traced = await ask(QUESTION, { onStage: () => {} });
    const withObserver = await countRuns();
    const plain = await ask(QUESTION);
    const withoutObserver = await countRuns();

    expect(traced.kind).toBe("answer");
    expect(plain.kind).toBe(traced.kind);
    // One run row either way: the observer observes, it does not participate.
    expect(withObserver - before).toBe(1);
    expect(withoutObserver - withObserver).toBe(1);
  });
});
