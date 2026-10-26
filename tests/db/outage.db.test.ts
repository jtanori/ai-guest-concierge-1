/**
 * S07-05 — kill the AI mid-conversation; the guest still gets an honest message.
 *
 * The AC has two halves that fail in different ways if nobody tests them:
 *
 *  - **the guest's half** — a catalogue sentence that promises a person, and a
 *    `service_requests` row behind that promise (S07-03's path);
 *  - **the operator's half** — an `ai_runs` row and a `message_failed` event, so
 *    an outage is a number on a dashboard and not a story guests tell later.
 *
 * Both are asserted for the same turn, because "it degraded" without evidence is
 * indistinguishable from "it quietly did nothing".
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider, createScriptedProvider } from "../../src/ai/stub.ts";
import { withChaos } from "../../src/ai/chaos.ts";
import { answerMessage } from "../../src/ai/answer.ts";
import { recordAiRun } from "../../src/ai/runs.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { t } from "../../src/i18n/catalog.ts";
import { postGuestMessage, type GuestDeps } from "../../src/guest/service.ts";
import { verifyGuestTicket } from "../../src/guest/cookie.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const SECRET = "o".repeat(40);
const SLUG = "outage-hotel";
const AT = new Date("2026-10-25T17:00:00.000Z");
const BODY = "El desayuno se sirve de 7:00 a 10:30 en el restaurante, todos los días.";

let client: pg.Client;
let tenant: TenantContext;
let propertyId: string;
let versionId: string;

/** The answer a healthy provider would give, for the turns that must succeed. */
function healthyAnswer(): Record<string, unknown> {
  return {
    decision: "answer",
    answer: "El desayuno se sirve de 7:00 a 10:30 en el restaurante.",
    language: "es-MX",
    citations: [{ article_version_id: versionId, quote: "se sirve de 7:00 a 10:30" }],
    reason_code: null,
    topic_keys_used: ["breakfast.hours"],
    confidence: 0.9,
  };
}

function healthyAi() {
  return withResilience(
    createFixedProvider(healthyAnswer(), "stub-primary-2026-01-01"),
    createFixedProvider(healthyAnswer(), "stub-fallback-2026-01-01"),
    { retries: 0, sleep: async () => {}, now: () => 0 },
  );
}

/**
 * A provider pair that fails the way a real outage fails — both models down, the
 * wrapper's own `AiUnavailableError`. Not a hand-rolled error: the point is that
 * the production error class is what the path handles.
 */
function downAi(modelIds = ["stub-primary-2026-01-01", "stub-fallback-2026-01-01"]) {
  return withResilience(
    createScriptedProvider([new Error("primary down")], modelIds[0]!),
    createScriptedProvider([new Error("fallback down")], modelIds[1]!),
    { retries: 0, sleep: async () => {}, now: () => 0 },
  );
}

function deps(ai = healthyAi()): GuestDeps {
  return { ai, cookieSecret: SECRET, now: () => AT };
}

async function rowsFor(conversationId: string) {
  const runs = await client.query<{
    decision: string;
    reason_code: string | null;
    model_id: string;
    usage: Record<string, unknown>;
  }>(
    "SELECT decision, reason_code, model_id, usage FROM ai_runs WHERE conversation_id = $1 ORDER BY created_at, ai_run_id",
    [conversationId],
  );
  const events = await client.query<{ event_type: string; payload: Record<string, unknown> }>(
    "SELECT event_type, payload FROM events WHERE conversation_id = $1 ORDER BY event_id",
    [conversationId],
  );
  const requests = await client.query<{ topic: string; status: string }>(
    "SELECT topic, status FROM service_requests WHERE conversation_id = $1",
    [conversationId],
  );
  return {
    runs: runs.rows,
    events: events.rows,
    requests: requests.rows,
    eventTypes: events.rows.map((row) => row.event_type),
  };
}

describe("outage fallback (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    const seeded = await seedTenant(client, "outage");
    tenant = { orgId: seeded.orgId, propertyId: seeded.propertyId };
    propertyId = seeded.propertyId;
    await client.query(
      "UPDATE properties SET slug = $2, settings = $3::jsonb WHERE property_id = $1",
      [propertyId, SLUG, JSON.stringify(DEFAULT_SETTINGS)],
    );

    // One published, chunked article: without it every turn fails closed to
    // `no_answer` and the outage path would never be reached.
    await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      const created = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'breakfast.hours', 'Desayuno', 'es') RETURNING article_id`,
        [tenant.orgId, propertyId],
      );
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, $4, $5::vector)
         RETURNING article_version_id`,
        [tenant.orgId, propertyId, created.rows[0]!.article_id, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
      versionId = version.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [versionId]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [tenant.orgId, propertyId, versionId, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
    });
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("answers normally when the provider is up (the control case)", async () => {
    const turn = await postGuestMessage(deps(), client, {
      slug: SLUG,
      text: "¿A qué hora es el desayuno?",
    });
    expect(turn.decision).toBe("answer");
    const found = await rowsFor(turn.conversationId);
    expect(found.runs.map((run) => run.decision)).toEqual(["answer"]);
    expect(found.eventTypes).not.toContain("message_failed");
    expect(found.requests).toEqual([]);
  });

  it("AC-1/AC-2: an outage mid-turn gives an honest reply, a request, a run row and message_failed", async () => {
    const turn = await postGuestMessage(deps(downAi()), client, {
      slug: SLUG,
      text: "¿A qué hora es el desayuno?",
    });

    // ---- the guest's half -------------------------------------------------
    expect(turn.decision).toBe("unavailable");
    expect(turn.reasonCode).toBe("ai_unavailable");
    expect(turn.messages).toHaveLength(2);
    // Catalogue copy, never model text and never an empty reply.
    const outbound = turn.messages.find((message) => message.direction === "outbound")!;
    expect(outbound.body).toContain(t("guest.unavailable", "es"));
    expect(outbound.body.trim()).not.toBe("");

    const found = await rowsFor(turn.conversationId);
    // The promise the guest just read is backed by a row.
    expect(found.requests).toHaveLength(1);
    expect(found.requests[0]!.topic).toBe("ai_unavailable");

    // ---- the operator's half ---------------------------------------------
    expect(found.runs).toHaveLength(1);
    expect(found.runs[0]).toMatchObject({
      decision: "escalate",
      reason_code: "provider_unavailable",
      // Never a model that did not answer: per-model accuracy reads this table.
      model_id: "none",
    });
    expect(found.runs[0]!.usage["outage"]).toBe(true);
    expect(found.runs[0]!.usage["models"]).toEqual([
      "stub-primary-2026-01-01",
      "stub-fallback-2026-01-01",
    ]);

    const failed = found.events.filter((event) => event.event_type === "message_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({
      reason_code: "provider_unavailable",
      ai_run_id: expect.any(String),
    });
    expect(failed[0]!.payload["models"]).toEqual([
      "stub-primary-2026-01-01",
      "stub-fallback-2026-01-01",
    ]);
  });

  it("survives the mid-conversation shape: answer, outage, answer", async () => {
    // "Kill the AI mid-conversation" is the AC's actual wording, so the outage is
    // produced the way an operator would produce it: a healthy provider wrapped
    // in `AI_FAIL_MODE=once`. That exercises the real chaos hook, the real
    // wrapper's `AiUnavailableError`, and the real outage path — not a
    // hand-scripted failure that only proves the test can throw.
    const chaotic = withChaos(healthyAi(), "once");
    // Turn 1 with a healthy provider (a different conversation, so the ticket is
    // not needed): the point is the conversation survives an outage turn.
    const first = await postGuestMessage(deps(), client, {
      slug: SLUG,
      text: "¿A qué hora es el desayuno?",
    });
    expect(first.decision).toBe("answer");

    // Turn 2 in the SAME conversation: the one deliberate failure fires here.
    const second = await postGuestMessage(deps(chaotic), client, {
      slug: SLUG,
      text: "¿Y el desayuno del domingo?",
      ticket: first.ticket ? verifyGuestTicket(first.ticket, SECRET) : null,
    });
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.decision).toBe("unavailable");

    // Turn 3, provider back. The conversation is now parked for a human — an
    // outage handed it to the team (S06-02's `awaiting_staff`), so the next turn
    // does NOT quietly resume answering behind the human's back. That is the
    // point of "mid-conversation": the outage has a consequence, and the
    // consequence is a person, not a silent recovery.
    const third = await postGuestMessage(deps(), client, {
      slug: SLUG,
      text: "¿Hay servicio de habitaciones?",
      ticket: first.ticket ? verifyGuestTicket(first.ticket, SECRET) : null,
    });
    expect(third.conversationId).toBe(first.conversationId);
    expect(third.decision).toBe("handoff");
    expect(third.messages[1]!.body).toContain(t("guest.staff_reply_pending", "es"));

    const found = await rowsFor(first.conversationId);
    // Two model runs: the answer and the outage. The third turn never reached
    // the model, because a human owns the thread.
    expect(found.runs.map((run) => run.reason_code)).toEqual([null, "provider_unavailable"]);
    expect(found.eventTypes.filter((name) => name === "message_failed")).toHaveLength(1);
    expect(chaotic.isCircuitOpen()).toBe(false);
  });

  it("records nothing for the outage when the turn rolls back", async () => {
    // The evidence must belong to the turn that happened. A rolled-back turn
    // leaves no ai_runs row, no event and no request — otherwise the outage
    // dashboard would count failures the guest never saw.
    const before = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM ai_runs WHERE reason_code = 'provider_unavailable'",
    );
    await expect(
      withTenant(client, tenant, async (tx) => {
        await tx.query("SET LOCAL ROLE concierge_app");
        await answerMessage(
          tx,
          tenant,
          {
            conversationId: (
              await tx.query<{ conversation_id: string }>(
                "SELECT conversation_id FROM conversations WHERE property_id = $1 LIMIT 1",
                [propertyId],
              )
            ).rows[0]!.conversation_id,
            messageId: null,
            text: "¿A qué hora es el desayuno?",
            language: "es",
            channel: "web",
            at: AT,
          },
          { ai: downAi() },
        );
        throw new Error("downstream failure");
      }),
    ).rejects.toThrow("downstream failure");

    const after = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM ai_runs WHERE reason_code = 'provider_unavailable'",
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("refuses an invented reason code on an ai_run (the vocabulary is closed)", async () => {
    const conversation = await client.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM conversations WHERE property_id = $1 LIMIT 1",
      [propertyId],
    );
    await expect(
      withTenant(client, tenant, async (tx) => {
        await tx.query("SET LOCAL ROLE concierge_app");
        return recordAiRun(tx, tenant, {
          conversationId: conversation.rows[0]!.conversation_id,
          messageId: null,
          modelId: "stub-primary-2026-01-01",
          promptVersion: "test",
          decision: "escalate",
          // A code nobody can query is a code that will never be alerted on.
          reasonCode: "provider_on_fire" as never,
          confidence: null,
          latencyMs: null,
        });
      }),
    ).rejects.toThrow(/reasonCode must be one of/);
  });
});
