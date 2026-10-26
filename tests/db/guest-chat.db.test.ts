/**
 * S06-01 — a stranger holds a full conversation, against a real database.
 *
 * What each block is for:
 *
 *  - **AC-1** a turn persists the inbound message AND the outbound one, in one
 *    conversation, with a signed cookie that survives to the next turn.
 *  - **AC-2** the tenant comes from the slug. A body carrying a foreign
 *    `propertyId`/`orgId` changes nothing — the rows land where the slug says —
 *    and the lookup role cannot read a column or a table it was not granted.
 *  - **AC-3** the disclosure travels with the property view, and the
 *    "talk to a person" button's own text escalates as `guest_asked_human`
 *    (proving the route to a human is real, not decorative).
 *
 * The provider is scripted, so every reply text here is the test's choice.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider, createScriptedProvider } from "../../src/ai/stub.ts";
import { withTenant } from "../../src/db/tenant.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { t } from "../../src/i18n/catalog.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { signGuestTicket, verifyGuestTicket } from "../../src/guest/cookie.ts";
import { handleGuestRequest, type GuestHttpDeps } from "../../src/guest/http.ts";
import {
  loadPublicProperty,
  loadTranscript,
  postGuestMessage,
  UnknownPropertyError,
  type GuestDeps,
} from "../../src/guest/service.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

const SECRET = "g".repeat(40);
const SLUG = "casa-mesa";
const BODY = "La alberca abre a las 07:00 y cierra a las 21:00 todos los días.";

let client: pg.Client;
let orgId: string;
let propertyId: string;
let otherOrgId: string;
let otherPropertyId: string;
let versionId: string;

function ai(output: unknown) {
  return withResilience(
    createFixedProvider(output, "stub-primary-2026-01-01"),
    createFixedProvider(output, "stub-fallback-2026-01-01"),
    { retries: 0, sleep: async () => {}, now: () => 0 },
  );
}

function deps(output: unknown = {}): GuestDeps {
  return { ai: ai(output), cookieSecret: SECRET, now: () => new Date("2026-10-25T15:00:00Z") };
}

function httpDeps(output: unknown = {}): GuestHttpDeps {
  return { client, ...deps(output) };
}

/** A scripted "answer" that cites the seeded version, quoting a real phrase. */
function citedAnswer() {
  return {
    decision: "answer",
    answer: "La alberca abre a las 07:00 y cierra a las 21:00.",
    language: "es-MX",
    citations: [{ article_version_id: versionId, quote: "abre a las 07:00" }],
    reason_code: null,
    topic_keys_used: ["pool.hours"],
    confidence: 0.9,
  };
}

interface FakeCall {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function fakeRequest(options: {
  method?: string;
  url: string;
  body?: unknown;
  cookie?: string;
}): { req: unknown; res: unknown; result: Promise<FakeCall> } {
  const headers: Record<string, string> = {};
  let status = 200;
  let payload = "";
  let resolve: (call: FakeCall) => void = () => {};
  const result = new Promise<FakeCall>((done) => {
    resolve = done;
  });

  const res = {
    writeHead: (code: number, extra?: Record<string, string>) => {
      status = code;
      for (const [name, value] of Object.entries(extra ?? {})) headers[name.toLowerCase()] = value;
    },
    setHeader: (name: string, value: unknown) => {
      headers[name.toLowerCase()] = String(value);
    },
    removeHeader: (name: string) => {
      delete headers[name.toLowerCase()];
    },
    end: (chunk?: string) => {
      payload = chunk ?? "";
      resolve({ status, body: payload === "" ? {} : (JSON.parse(payload) as Record<string, unknown>), headers });
    },
  };

  const text = options.body === undefined ? "" : JSON.stringify(options.body);
  const req = {
    method: options.method ?? "POST",
    url: options.url,
    headers: {
      host: "localhost",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(text === "" ? {} : { "content-type": "application/json" }),
    },
    socket: {},
    async *[Symbol.asyncIterator]() {
      if (text !== "") yield Buffer.from(text);
    },
  };

  return { req, res, result };
}

async function call(options: {
  method?: string;
  url: string;
  body?: unknown;
  cookie?: string;
}): Promise<FakeCall> {
  const fake = fakeRequest(options);
  await handleGuestRequest(
    fake.req as Parameters<typeof handleGuestRequest>[0],
    fake.res as Parameters<typeof handleGuestRequest>[1],
    httpDeps(),
  );
  return fake.result;
}

async function messageCount(property: string): Promise<number> {
  const rows = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM messages WHERE property_id = $1",
    [property],
  );
  return Number(rows.rows[0]!.n);
}

describe("guest chat (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const org = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Casa Mesa', 'casa-mesa-org') RETURNING org_id",
    );
    orgId = org.rows[0]!.org_id;
    const property = await client.query<{ property_id: string }>(
      `INSERT INTO properties (org_id, name, slug, time_zone, settings)
       VALUES ($1, 'Hotel Casa Mesa', $2, 'America/Mexico_City', $3::jsonb)
       RETURNING property_id`,
      [orgId, SLUG, JSON.stringify(DEFAULT_SETTINGS)],
    );
    propertyId = property.rows[0]!.property_id;

    const other = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Other', 'other-org') RETURNING org_id",
    );
    otherOrgId = other.rows[0]!.org_id;
    const otherProperty = await client.query<{ property_id: string }>(
      `INSERT INTO properties (org_id, name, slug, time_zone, settings)
       VALUES ($1, 'Other Hotel', 'other-hotel', 'UTC', $2::jsonb)
       RETURNING property_id`,
      [otherOrgId, JSON.stringify(DEFAULT_SETTINGS)],
    );
    otherPropertyId = otherProperty.rows[0]!.property_id;

    // One published, chunked article so the "answer" path has something to cite.
    // Seeded through the tenant transaction: promotion reads the tenant GUCs
    // (0003) and refuses to run outside them.
    versionId = await withTenant(client, { orgId, propertyId }, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      const created = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'pool.hours', 'Alberca', 'es') RETURNING article_id`,
        [orgId, propertyId],
      );
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, $4, $5::vector)
         RETURNING article_version_id`,
        [orgId, propertyId, created.rows[0]!.article_id, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
      const promoted = version.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [promoted]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [orgId, propertyId, promoted, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
      return promoted;
    });
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("persists both messages of a first turn and issues a signed ticket (AC-1)", async () => {
    const turn = await postGuestMessage(deps({}), client, {
      slug: SLUG,
      text: "Quiero un reembolso de la noche del sábado",
      language: "es",
    });

    expect(turn.decision).toBe("escalate");
    expect(turn.reasonCode).toBe("sensitive_topic");
    expect(turn.messages).toHaveLength(2);
    // The guest's exact words, and the catalogue string — never model text.
    expect(turn.messages[0]!.body).toBe("Quiero un reembolso de la noche del sábado");
    expect(turn.messages[1]!.body).toBe(t("guest.idontknow", "es"));
    expect(turn.property.disclosure).toBe(t("guest.ai_disclosure", "es"));

    const stored = await client.query<{ direction: string; author_role: string; body: string }>(
      "SELECT direction, author_role, body FROM messages WHERE conversation_id = $1 ORDER BY created_at, message_id",
      [turn.conversationId],
    );
    expect(stored.rows.map((row) => `${row.direction}/${row.author_role}`)).toEqual([
      "inbound/guest",
      "outbound/ai",
    ]);

    const conversation = await client.query<{ identity_id: string | null; property_id: string }>(
      "SELECT identity_id, property_id FROM conversations WHERE conversation_id = $1",
      [turn.conversationId],
    );
    expect(conversation.rows[0]!.property_id).toBe(propertyId);
    expect(conversation.rows[0]!.identity_id).not.toBeNull();

    const ticket = verifyGuestTicket(turn.ticket, SECRET);
    expect(ticket).toEqual({
      identityId: conversation.rows[0]!.identity_id,
      conversationId: turn.conversationId,
      propertyId,
    });
  });

  it("continues the same conversation from the ticket, creating nothing new", async () => {
    const ticket = {
      identityId: "00000000-0000-4000-8000-000000000000",
      conversationId: null as string | null,
      propertyId,
    };
    const first = await postGuestMessage(deps({}), client, {
      slug: SLUG,
      text: "Hola, ¿tienen wifi?",
      language: "es",
    });
    const verified = verifyGuestTicket(first.ticket, SECRET)!;
    expect(verified.identityId).not.toBe(ticket.identityId);

    const before = await client.query<{ n: string }>("SELECT count(*) AS n FROM conversations");
    const second = await postGuestMessage(deps({}), client, {
      slug: SLUG,
      text: "Gracias",
      language: "es",
      ticket: verified,
    });
    const after = await client.query<{ n: string }>("SELECT count(*) AS n FROM conversations");
    expect(second.conversationId).toBe(first.conversationId);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("ignores a forged tenant in the body — the slug decides where rows land (AC-2)", async () => {
    const before = await messageCount(otherPropertyId);
    const response = await call({
      url: `/api/chat/messages?property=${SLUG}`,
      body: {
        text: "¿Hay estacionamiento?",
        orgId: otherOrgId,
        propertyId: otherPropertyId,
        conversationId: "11111111-1111-4111-a111-111111111111",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body["decision"]).toBeDefined();
    const landed = await client.query<{ property_id: string }>(
      "SELECT property_id FROM messages WHERE message_id = $1",
      [(response.body["messages"] as Array<{ messageId: string }>)[0]!.messageId],
    );
    expect(landed.rows[0]!.property_id).toBe(propertyId);
    // And the property the body asked for got nothing.
    expect(await messageCount(otherPropertyId)).toBe(before);
  });

  it("404s an unknown slug and a slug that belongs to a property we do not know", async () => {
    await expect(
      postGuestMessage(deps({}), client, { slug: "does-not-exist", text: "hola", language: "es" }),
    ).rejects.toBeInstanceOf(UnknownPropertyError);

    const response = await call({ url: "/api/chat/messages?property=nope", body: { text: "hola" } });
    expect(response.status).toBe(404);
    expect(response.body["error"]).toBe("unknown_property");
  });

  it("keeps the public lookup role to six columns and one slug (0015)", async () => {
    // Each probe gets its own transaction: a denied statement aborts the
    // transaction it ran in, and a shared one would report 25P02 instead of the
    // permission error we are actually asserting.
    async function asPublic<T>(slug: string | null, fn: () => Promise<T>): Promise<T> {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE concierge_public");
        if (slug !== null) await client.query("SELECT set_config('app.property_slug', $1, true)", [slug]);
        return await fn();
      } finally {
        await client.query("ROLLBACK");
      }
    }

    const visible = await asPublic(SLUG, () =>
      client.query<{ slug: string }>("SELECT slug FROM properties"),
    );
    expect(visible.rows.map((row) => row.slug)).toEqual([SLUG]);

    // Another slug is not merely filtered — it is not in the policy's scope.
    const other = await asPublic("other-hotel", () =>
      client.query<{ slug: string }>("SELECT slug FROM properties"),
    );
    expect(other.rows.map((row) => row.slug)).toEqual(["other-hotel"]);

    // No slug in the request context: no rows at all, not "all rows".
    const none = await asPublic(null, () => client.query<{ slug: string }>("SELECT slug FROM properties"));
    expect(none.rows).toEqual([]);

    await expect(
      asPublic(SLUG, () => client.query("SELECT settings FROM properties")),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asPublic(SLUG, () => client.query("SELECT count(*) FROM messages")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("sends the catalogue string, not model text, for the person request (AC-3)", async () => {
    const property = await loadPublicProperty(client, { slug: SLUG });
    const turn = await postGuestMessage(deps({}), client, {
      slug: SLUG,
      text: property.talkToPerson,
      language: "es",
    });
    expect(turn.reasonCode).toBe("guest_asked_human");
    expect(turn.messages[1]!.body).toBe(t("guest.idontknow", "es"));
    // The human route is a message, so the handoff is in the transcript.
    const stored = await client.query<{ body: string }>(
      "SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'inbound'",
      [turn.conversationId],
    );
    expect(stored.rows[0]!.body).toBe(property.talkToPerson);
  });

  it("persists a verified model answer as the outbound message", async () => {
    const turn = await postGuestMessage(deps(citedAnswer()), client, {
      slug: SLUG,
      text: "alberca abre",
      language: "es",
    });
    expect(turn.decision).toBe("answer");
    expect(turn.messages[1]!.body).toBe("La alberca abre a las 07:00 y cierra a las 21:00.");

    const run = await client.query<{ decision: string; model_id: string }>(
      "SELECT decision, model_id FROM ai_runs WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1",
      [turn.conversationId],
    );
    expect(run.rows[0]).toEqual({ decision: "answer", model_id: "stub-primary-2026-01-01" });
  });

  it("degrades to 'a person will reply' when both providers fail, and still persists", async () => {
    const failing = withResilience(
      createScriptedProvider([new Error("primary down")], "stub-primary-2026-01-01"),
      createScriptedProvider([new Error("fallback down")], "stub-fallback-2026-01-01"),
      { retries: 0, sleep: async () => {}, now: () => 0 },
    );
    const turn = await postGuestMessage(
      { ai: failing, cookieSecret: SECRET, now: () => new Date("2026-10-25T15:00:00Z") },
      client,
      { slug: SLUG, text: "alberca abre", language: "es" },
    );
    expect(turn.decision).toBe("unavailable");
    expect(turn.reasonCode).toBe("ai_unavailable");
    expect(turn.messages[1]!.body).toBe(t("guest.unavailable", "es"));
    expect(turn.messages).toHaveLength(2);
  });

  it("reads the transcript back under RLS, and nothing for a foreign ticket", async () => {
    const first = await postGuestMessage(deps({}), client, {
      slug: SLUG,
      text: "¿A qué hora es el desayuno?",
      language: "es",
    });
    const ticket = verifyGuestTicket(first.ticket, SECRET)!;

    const transcript = await loadTranscript(client, { slug: SLUG, ticket });
    expect(transcript.conversationId).toBe(first.conversationId);
    expect(transcript.messages.map((message) => message.direction)).toEqual([
      "inbound",
      "outbound",
    ]);

    // A ticket minted for another property is ignored, not honoured or leaked.
    const foreign = signGuestTicket(
      { identityId: ticket.identityId, conversationId: ticket.conversationId, propertyId: otherPropertyId },
      SECRET,
    );
    const ignored = await loadTranscript(client, {
      slug: SLUG,
      ticket: verifyGuestTicket(foreign, SECRET)!,
    });
    expect(ignored.messages).toEqual([]);
  });
});
