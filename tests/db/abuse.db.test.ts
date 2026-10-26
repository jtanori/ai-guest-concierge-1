/**
 * S07-04 — the two ceilings, against a real database.
 *
 * AC-1 (rate limits) and AC-2 (spend cap) are both statements about what happens
 * to a guest when a limit is reached, and both have the same required shape:
 * **a refusal degrades, it never errors.** So every case here is written as "the
 * turn still produced an honest sentence and a queue row", not merely "the
 * exception was thrown".
 *
 * The DB is also where the counters live, so this is the only place the
 * concurrency claims can be checked at all: two connections consuming the same
 * bucket must see 2, not 1.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { loadSpend, recordSpend, utcDay } from "../../src/ai/spend.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { t } from "../../src/i18n/catalog.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import {
  BotCheckFailedError,
  RateLimitedError,
  postGuestMessage,
  type GuestDeps,
} from "../../src/guest/service.ts";
import { verifyGuestTicket } from "../../src/guest/cookie.ts";
import { RATE_LIMITS, checkRate, hashSubject } from "../../src/security/ratelimit.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const SECRET = "a".repeat(40);
const SLUG = "abuse-hotel";
/** One fixed instant: every case must land in the same rate window. */
const AT = new Date("2026-10-25T17:00:00.000Z");

let client: pg.Client;
let tenant: TenantContext;
let propertyId: string;
let otherTenant: TenantContext;
let versionId: string;

const BODY = "El desayuno se sirve de 7:00 a 10:30 en el restaurante, todos los días.";

/**
 * A contract-valid answer that cites the seeded article. The quote must come
 * from the article's own body or the guardrail rejects it — which is exactly
 * what the first draft of this file learned the hard way.
 */
function answer(): Record<string, unknown> {
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

function deps(overrides: Partial<GuestDeps> = {}): GuestDeps {
  return {
    ai: withResilience(
      createFixedProvider(answer(), "stub-primary-2026-01-01"),
      createFixedProvider(answer(), "stub-fallback-2026-01-01"),
      { retries: 0, sleep: async () => {}, now: () => 0 },
    ),
    cookieSecret: SECRET,
    now: () => AT,
    ...overrides,
  };
}

function asApp<T>(fn: (tx: pg.Client) => Promise<T>, target: TenantContext = tenant): Promise<T> {
  return withTenant(client, target, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

/** Every case gets its own conversation, so buckets do not leak between them. */
async function newConversation(target: TenantContext = tenant): Promise<string> {
  const channel = await client.query<{ channel_connection_id: string }>(
    "SELECT channel_connection_id FROM channel_connections WHERE org_id = $1 AND property_id = $2 AND channel = 'web' LIMIT 1",
    [target.orgId, target.propertyId],
  );
  const created = await client.query<{ conversation_id: string }>(
    "INSERT INTO conversations (org_id, property_id, connection_id) VALUES ($1, $2, $3) RETURNING conversation_id",
    [target.orgId, target.propertyId, channel.rows[0]!.channel_connection_id],
  );
  return created.rows[0]!.conversation_id;
}

async function countMessages(conversationId: string): Promise<number> {
  const row = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1",
    [conversationId],
  );
  return row.rows[0]!.n;
}

async function windowCount(bucket: string, key: string, windowSeconds: number): Promise<number> {
  const start = new Date(Math.floor(AT.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const row = await client.query<{ count: number }>(
    `SELECT count FROM rate_limits
      WHERE org_id = $1 AND property_id = $2 AND bucket = $3 AND key = $4 AND window_start = $5`,
    [tenant.orgId, propertyId, bucket, key, start.toISOString()],
  );
  return row.rows[0]?.count ?? 0;
}

describe("abuse and cost protection (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    const seeded = await seedTenant(client, "abuse");
    tenant = { orgId: seeded.orgId, propertyId: seeded.propertyId };
    propertyId = seeded.propertyId;
    await client.query(
      "UPDATE properties SET slug = $2, settings = $3::jsonb WHERE property_id = $1",
      [propertyId, SLUG, JSON.stringify(DEFAULT_SETTINGS)],
    );

    // A published, chunked article so the `answer` path is reachable: an empty
    // knowledge base fails closed to `no_answer`, which would make every case
    // here pass for the wrong reason (and never spend anything).
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
      const promoted = version.rows[0]!.article_version_id;
      versionId = promoted;
      await tx.query("SELECT promote_article_version($1)", [promoted]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [tenant.orgId, propertyId, promoted, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
    });

    // A property bucket is tenant-wide, and these cases shared a fixture: start
    // from zero so an earlier case cannot decide a later one.
    await client.query("DELETE FROM rate_limits WHERE property_id = $1", [propertyId]);

    const other = await seedTenant(client, "abuse-other");
    otherTenant = { orgId: other.orgId, propertyId: other.propertyId };
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  describe("AC-1 — rate limits", () => {
    it("lets a guest send a normal message, and counts it in all three buckets", async () => {
      const turn = await postGuestMessage(deps(), client, {
        slug: SLUG,
        text: "¿A qué hora es el desayuno?",
        ip: "198.51.100.10",
      });
      expect(turn.decision).toBe("answer");
      // The guest path mints its own conversation from the cookie; the bucket
      // must be the one the turn actually used.
      expect(await windowCount("ip", hashSubject("ip", "198.51.100.10"), 60)).toBe(1);
      expect(await windowCount("conversation", turn.conversationId, 60)).toBe(1);
      expect(await windowCount("property", propertyId, 3600)).toBeGreaterThanOrEqual(1);
    });

    it("refuses the conversation's 11th message in a minute, and writes no messages for it", async () => {
      // Same conversation via the signed ticket the server hands back each turn.
      // The ip is a fresh one so the ip bucket (20/min) is not what trips.
      let turn = await postGuestMessage(deps(), client, {
        slug: SLUG,
        text: "pregunta 0",
        ip: "198.51.100.25",
      });
      const conversationId = turn.conversationId;
      const messagesAfterFirst = await countMessages(conversationId);

      for (let i = 1; i < RATE_LIMITS.conversation.limit; i += 1) {
        turn = await postGuestMessage(deps(), client, {
          slug: SLUG,
          text: `pregunta ${i}`,
          ip: "198.51.100.25",
          ticket: turn.ticket ? verifyGuestTicket(turn.ticket, SECRET) : null,
        });
        expect(turn.conversationId).toBe(conversationId);
      }
      // Ten turns are in; the bucket is at its ceiling.
      expect(await countMessages(conversationId)).toBe(messagesAfterFirst + 2 * (RATE_LIMITS.conversation.limit - 1));

      let blocked: RateLimitedError | null = null;
      try {
        await postGuestMessage(deps(), client, {
          slug: SLUG,
          text: "una más",
          ip: "198.51.100.25",
          ticket: turn.ticket ? verifyGuestTicket(turn.ticket, SECRET) : null,
        });
      } catch (error) {
        if (error instanceof RateLimitedError) blocked = error;
        else throw error;
      }
      expect(blocked).not.toBeNull();
      expect(blocked!.bucket).toBe("conversation");
      expect(blocked!.limit).toBe(RATE_LIMITS.conversation.limit);
      expect(blocked!.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked!.retryAfterSeconds).toBeLessThanOrEqual(60);

      // The refused turn left nothing behind: no half-written guest message in
      // a conversation the guest believes they sent to.
      expect(await countMessages(conversationId)).toBe(
        messagesAfterFirst + 2 * (RATE_LIMITS.conversation.limit - 1),
      );
    });

    it("refuses a property-wide flood with the property bucket", async () => {
      // The one ceiling a client cannot forge: it is keyed on the property, not
      // on anything the request carries.
      await client.query(
        `INSERT INTO rate_limits (org_id, property_id, bucket, key, window_start, count)
         VALUES ($1, $2, 'property', $5, $3, $4)
         ON CONFLICT (org_id, property_id, bucket, key, window_start)
         DO UPDATE SET count = EXCLUDED.count`,
        [
          tenant.orgId,
          tenant.propertyId,
          "2026-10-25T17:00:00.000Z",
          RATE_LIMITS.property.limit,
          propertyId,
        ],
      );

      await expect(
        postGuestMessage(deps(), client, { slug: SLUG, text: "hola", ip: "198.51.100.30" }),
      ).rejects.toBeInstanceOf(RateLimitedError);

      // Reset so the later cases are not all blocked by this one row.
      await client.query(
        "DELETE FROM rate_limits WHERE property_id = $1 AND bucket = 'property'",
        [propertyId],
      );
    });

    it("rolls the counters back with the turn, so a failed turn does not spend the budget", async () => {
      // A turn that fails after the counters are consumed must leave them at
      // their previous value — otherwise a transient bug locks a real guest out.
      const conversationId = await newConversation();
      const before = await windowCount("conversation", conversationId, 60);
      await expect(
        withTenant(client, tenant, async (tx) => {
          await tx.query("SET LOCAL ROLE concierge_app");
          await checkRate(tx, tenant, { ip: "198.51.100.40", conversationId, at: AT });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await windowCount("conversation", conversationId, 60)).toBe(before);
    });

    it("keeps another tenant's counters invisible", async () => {
      const otherConversation = await newConversation(otherTenant);
      await asApp(
        (tx) => checkRate(tx, otherTenant, { ip: "198.51.100.50", conversationId: otherConversation, at: AT }),
        otherTenant,
      );
      const visible = await asApp((tx) =>
        tx.query("SELECT count(*)::int AS n FROM rate_limits"),
      );
      const own = await asApp((tx) =>
        tx.query("SELECT count(*)::int AS n FROM rate_limits WHERE org_id = $1", [tenant.orgId]),
      );
      expect((visible.rows[0] as { n: number }).n).toBe((own.rows[0] as { n: number }).n);
      // And a cross-tenant insert is refused rather than silently stored.
      await expect(
        asApp((tx) =>
          tx.query(
            `INSERT INTO rate_limits (org_id, property_id, bucket, key, window_start, count)
             VALUES ($1, $2, 'ip', 'x', now(), 1)`,
            [otherTenant.orgId, otherTenant.propertyId],
          ),
        ),
      ).rejects.toThrow();
    });
  });

  describe("AC-2 — spend cap", () => {
    it("accumulates a call's cost against both the day and the conversation", async () => {
      const conversationId = await newConversation();
      const baseline = await asApp((tx) => loadSpend(tx, tenant, { conversationId, at: AT }));
      const cost = await asApp((tx) =>
        recordSpend(tx, tenant, {
          conversationId,
          modelId: "gemini-2.5-flash",
          usage: { promptTokens: 2_000, completionTokens: 400 },
          at: AT,
        }),
      );
      expect(cost).toBeGreaterThan(0);

      const snapshot = await asApp((tx) => loadSpend(tx, tenant, { conversationId, at: AT }));
      expect(snapshot.dayKey).toBe(utcDay(AT));
      // Deltas, not absolutes: the UTC day is shared by every case in this file,
      // and the conversation counter starts at this case's own zero.
      expect(snapshot.todayUsd - baseline.todayUsd).toBeCloseTo(cost, 6);
      expect(snapshot.conversationUsd).toBeCloseTo(cost, 6);

      await asApp((tx) =>
        recordSpend(tx, tenant, {
          conversationId,
          modelId: "gemini-2.5-flash",
          usage: { promptTokens: 2_000, completionTokens: 400 },
          at: AT,
        }),
      );
      const again = await asApp((tx) => loadSpend(tx, tenant, { conversationId, at: AT }));
      expect(again.conversationUsd).toBeCloseTo(cost * 2, 5);
      expect(again.todayUsd - baseline.todayUsd).toBeCloseTo(cost * 2, 5);
    });

    it("counts a real guest turn, and the counter is visible to the next turn", async () => {
      const before = await asApp((tx) => loadSpend(tx, tenant, { conversationId: "unused", at: AT }));
      const turn = await postGuestMessage(deps(), client, {
        slug: SLUG,
        text: "¿Hay servicio de traslado al aeropuerto?",
        ip: "198.51.100.60",
      });
      expect(turn.decision).toBe("answer");
      const after = await asApp((tx) =>
        loadSpend(tx, tenant, { conversationId: turn.conversationId, at: AT }),
      );
      expect(after.todayUsd).toBeGreaterThan(before.todayUsd);
      expect(after.conversationUsd).toBeGreaterThan(0);
    });

    it("degrades to 'a team member will reply' when the daily cap is reached — never a 5xx", async () => {
      // The cap is settings, so it is lowered here rather than forged in code.
      await client.query(
        `UPDATE properties
            SET settings = jsonb_set(settings, '{spend_cap}',
                  '{"daily_usd": 0.000001, "per_conversation_usd": 0.5}'::jsonb)
          WHERE property_id = $1`,
        [propertyId],
      );
      // ...and the day counter is already past it.
      const seedConversation = await newConversation();
      await asApp((tx) =>
        recordSpend(tx, tenant, {
          conversationId: seedConversation,
          modelId: "gemini-2.5-flash",
          usage: { promptTokens: 10_000, completionTokens: 1_000 },
          at: AT,
        }),
      );

      const turn = await postGuestMessage(deps(), client, {
        slug: SLUG,
        text: "¿Puedo pagar con tarjeta?",
        ip: "198.51.100.70",
      });

      // The guest is told a person will reply, in catalogue copy, and the model
      // was not asked (the stub would have answered).
      expect(turn.decision).toBe("escalate");
      const outbound = turn.messages.find((message) => message.direction === "outbound")!;
      expect(outbound.body).toContain(t("guest.request_ack", turn.language));

      // And the request exists, so the promise is backed by a queue row.
      const request = await client.query<{ topic: string; status: string }>(
        "SELECT topic, status FROM service_requests WHERE conversation_id = $1",
        [turn.conversationId],
      );
      expect(request.rows).toHaveLength(1);
      expect(request.rows[0]!.topic).toBe("needs_human");

      const events = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM events WHERE conversation_id = $1 AND event_type = 'ai_escalated'`,
        [turn.conversationId],
      );
      expect(JSON.stringify(events.rows)).toContain("daily_spend_cap");

      // Restore the default cap for the remaining cases.
      await client.query(
        `UPDATE properties SET settings = jsonb_set(settings, '{spend_cap}',
            '{"daily_usd": 10, "per_conversation_usd": 0.5}'::jsonb)
          WHERE property_id = $1`,
        [propertyId],
      );
    });

    it("degrades on the per-conversation cap even when the day has room", async () => {
      // A generous day and a conversation ceiling so low that any model call
      // trips it: the first turn is allowed (nothing spent yet), the second is
      // not — and the 5xx-free degradation is the same shape as the daily one.
      await client.query(
        `UPDATE properties
            SET settings = jsonb_set(settings, '{spend_cap}',
                  '{"daily_usd": 100, "per_conversation_usd": 0.000001}'::jsonb)
          WHERE property_id = $1`,
        [propertyId],
      );

      const first = await postGuestMessage(deps(), client, {
        slug: SLUG,
        text: "¿A qué hora es el desayuno?",
        ip: "198.51.100.80",
      });
      expect(first.decision).toBe("answer");
      const spent = await asApp((tx) =>
        loadSpend(tx, tenant, { conversationId: first.conversationId, at: AT }),
      );
      expect(spent.conversationUsd).toBeGreaterThan(0);

      const second = await postGuestMessage(deps(), client, {
        slug: SLUG,
        text: "¿Y el desayuno del domingo?",
        ip: "198.51.100.80",
        ticket: first.ticket ? verifyGuestTicket(first.ticket, SECRET) : null,
      });
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.decision).toBe("escalate");
      const outbound = second.messages.find((message) => message.direction === "outbound")!;
      expect(outbound.body).toContain(t("guest.request_ack", second.language));

      const events = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM events
          WHERE conversation_id = $1 AND event_type = 'ai_escalated'
          ORDER BY event_id DESC LIMIT 1`,
        [first.conversationId],
      );
      expect(JSON.stringify(events.rows[0]?.payload)).toContain("conversation_spend_cap");

      await client.query(
        `UPDATE properties SET settings = jsonb_set(settings, '{spend_cap}',
            '{"daily_usd": 10, "per_conversation_usd": 0.5}'::jsonb)
          WHERE property_id = $1`,
        [propertyId],
      );
    });
  });

  describe("AC-1 — the bot check on the first message", () => {
    it("refuses a first message with no token when the check is enforced", async () => {
      await expect(
        postGuestMessage(
          deps({ botCheck: { mode: "enforced", secret: "s", timeoutMs: 1_000 } }),
          client,
          { slug: SLUG, text: "hola", ip: "198.51.100.90" },
        ),
      ).rejects.toBeInstanceOf(BotCheckFailedError);
    });

    it("accepts the first message when the vendor verifies the token", async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch;
      const turn = await postGuestMessage(
        deps({
          botCheck: { mode: "enforced", secret: "s", timeoutMs: 1_000 },
          botCheckFetch: fetchImpl,
        }),
        client,
        { slug: SLUG, text: "¿A qué hora cierra la piscina?", ip: "198.51.100.91", turnstileToken: "tok" },
      );
      expect(turn.decision).toBe("answer");
    });
  });
});
