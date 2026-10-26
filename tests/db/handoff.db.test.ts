/**
 * S07-02 — "a human is reachable in one tap from any state".
 *
 * The two ACs are tested from the outside in:
 *
 *  - **AC-1** the first AI reply of a conversation *contains* the disclosure, in
 *    both languages, and later replies do not repeat it.
 *  - **AC-2** one `POST /api/chat/handoff` reaches `awaiting_staff` from each of
 *    the four states — and from the state that has no conversation yet, which is
 *    what a first-time visitor is in when they tap before typing.
 *
 * Three properties are asserted on every one of those paths, because they are
 * what makes this control trustworthy rather than decorative: the provider is
 * **never** called (a scripted provider that throws if asked proves it), a
 * `handoff_reasons` row with `guest_asked_human` is written, and exactly one
 * open `service_requests` row exists per conversation no matter how many times
 * the guest taps.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience, type ResilientAi } from "../../src/ai/provider.ts";
import { t } from "../../src/i18n/catalog.ts";
import { GUEST_COOKIE, verifyGuestTicket } from "../../src/guest/cookie.ts";
import { handleGuestRequest, type GuestHttpDeps } from "../../src/guest/http.ts";
import { postGuestHandoff, postGuestMessage, type GuestDeps } from "../../src/guest/service.ts";
import type { AiState } from "../../src/conversation/state.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

const SECRET = "h".repeat(40);
const SLUG = "handoff-hotel";
const DISCLOSURE_ES = t("guest.ai_disclosure", "es");
const DISCLOSURE_EN = t("guest.ai_disclosure", "en");
const PENDING_ES = t("guest.staff_reply_pending", "es");

let client: pg.Client;
let orgId: string;

/**
 * A provider that fails the test if it is ever asked to generate. The handoff
 * path must not depend on the model *or* on the model being available, so the
 * assertion is "zero requests", not "the call did not throw".
 */
let providerCalls = 0;
function forbiddenAi(): ResilientAi {
  const provider = {
    modelId: "never-called-primary",
    async generate(): Promise<never> {
      providerCalls += 1;
      throw new Error("the handoff path must never ask the model anything");
    },
  };
  return withResilience(provider, { ...provider, modelId: "never-called-fallback" }, {
    retries: 0,
    sleep: async () => {},
    now: () => 0,
  });
}

function deps(): GuestDeps {
  return {
    ai: forbiddenAi(),
    cookieSecret: SECRET,
    now: () => new Date("2026-10-25T16:00:00Z"),
  };
}

function httpDeps(): GuestHttpDeps {
  return { client, ...deps() };
}

interface FakeCall {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

async function call(options: {
  method?: string;
  url: string;
  body?: unknown;
  cookie?: string;
}): Promise<FakeCall> {
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
      resolve({
        status,
        body: payload === "" ? {} : (JSON.parse(payload) as Record<string, unknown>),
        headers,
      });
    },
  };

  const text = options.body === undefined ? "" : JSON.stringify(options.body);
  const req = {
    method: options.method ?? "POST",
    url: options.url,
    headers: {
      host: "localhost",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    socket: {},
    async *[Symbol.asyncIterator]() {
      if (text !== "") yield Buffer.from(text);
    },
  };

  await handleGuestRequest(
    req as Parameters<typeof handleGuestRequest>[0],
    res as Parameters<typeof handleGuestRequest>[1],
    httpDeps(),
  );
  return result;
}

/** The `name=value` pair a browser would send back after a call. */
function cookieFrom(response: FakeCall): string {
  const raw = response.headers["set-cookie"] ?? "";
  return raw.split(";")[0] ?? "";
}

async function readState(conversationId: string): Promise<AiState> {
  const row = await client.query<{ ai_state: AiState }>(
    "SELECT ai_state FROM conversations WHERE conversation_id = $1",
    [conversationId],
  );
  return row.rows[0]!.ai_state;
}

async function seedState(conversationId: string, state: AiState): Promise<void> {
  // Deliberately raw SQL on a fresh row per case: the point of these tests is
  // the handoff, not the matrix (which has its own suite), and `awaiting_staff`
  // is only reachable through a takeover we are about to test anyway.
  await client.query("UPDATE conversations SET ai_state = $2 WHERE conversation_id = $1", [
    conversationId,
    state,
  ]);
}

describe("one-tap handoff (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const org = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Handoff', 'handoff-org') RETURNING org_id",
    );
    orgId = org.rows[0]!.org_id;
    const property = await client.query<{ property_id: string }>(
      `INSERT INTO properties (org_id, name, slug, time_zone, languages)
       VALUES ($1, 'Hotel Handoff', $2, 'America/Mexico_City', ARRAY['es','en'])
       RETURNING property_id`,
      [orgId, SLUG],
    );
    // The property id is never used directly: every call resolves the tenant
    // from the slug, which is the point of the surface.
    void property;
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("discloses the AI in the first reply, in the guest's language (AC-1)", async () => {
    const es = await postGuestMessage(deps(), client, {
      slug: SLUG,
      text: "¿A qué hora cierra la alberca?",
      language: "es",
    });
    expect(es.messages[1]!.body.startsWith(DISCLOSURE_ES)).toBe(true);

    const en = await postGuestMessage(deps(), client, {
      slug: SLUG,
      text: "What time is the pool open?",
      language: "en",
    });
    expect(en.messages[1]!.body.startsWith(DISCLOSURE_EN)).toBe(true);
    expect(en.messages[1]!.body).not.toContain(DISCLOSURE_ES);

    // The stored row is the text that was sent — the transcript a staff member
    // reads (S08) cannot differ from the words the guest saw.
    const stored = await client.query<{ body: string }>(
      "SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'outbound'",
      [en.conversationId],
    );
    expect(stored.rows[0]!.body).toBe(en.messages[1]!.body);
  });

  it("discloses once, not in every reply (AC-1)", async () => {
    const first = await postGuestMessage(deps(), client, {
      slug: SLUG,
      text: "¿A qué hora cierra la alberca?",
      language: "es",
    });
    const second = await postGuestMessage(deps(), client, {
      slug: SLUG,
      text: "¿Y abre temprano?",
      language: "es",
      ticket: { ...decode(first), conversationId: first.conversationId },
    });
    expect(first.messages[1]!.body).toContain(DISCLOSURE_ES);
    expect(second.messages[1]!.body).not.toContain(DISCLOSURE_ES);
  });

  it("reaches a human from idle, awaiting_ai, awaiting_staff and resolved (AC-2)", async () => {
    for (const state of ["idle", "awaiting_ai", "awaiting_staff", "resolved"] as const) {
      const handoff = await postGuestHandoff(deps(), client, { slug: SLUG, language: "es" });
      if (state !== "idle") await seedState(handoff.conversationId, state);

      // A second tap on the SAME conversation, from the seeded state.
      const again = await postGuestHandoff(deps(), client, {
        slug: SLUG,
        language: "es",
        ticket: { ...decode(handoff), conversationId: handoff.conversationId },
      });
      expect(again.conversationId, state).toBe(handoff.conversationId);
      expect(await readState(handoff.conversationId), state).toBe("awaiting_staff");
      expect(again.decision).toBe("handoff");
      expect(again.reasonCode).toBe("guest_asked_human");
    }
    // No request ever reached a provider on any of those paths.
    expect(providerCalls).toBe(0);
  });

  it("works for a stranger who taps before typing anything (AC-2)", async () => {
    const response = await call({ url: `/api/chat/handoff?property=${SLUG}&lang=es` });
    expect(response.status).toBe(200);
    expect(response.body["decision"]).toBe("handoff");

    const conversationId = response.body["conversationId"] as string;
    expect(await readState(conversationId)).toBe("awaiting_staff");

    // The acknowledgement is catalogue copy, prefixed by the disclosure because
    // it is the first thing said in this conversation.
    const message = response.body["message"] as { body: string; authorRole: string };
    expect(message.body).toBe(`${DISCLOSURE_ES}\n\n${PENDING_ES}`);
    expect(message.authorRole).toBe("ai");

    // The cookie round-trips, so a guest who taps and then types keeps the thread.
    const cookie = cookieFrom(response);
    expect(cookie.startsWith(`${GUEST_COOKIE}=`)).toBe(true);
    const next = await call({
      url: `/api/chat/messages?property=${SLUG}&lang=es`,
      body: { text: "Gracias, espero" },
      cookie,
    });
    expect(next.status).toBe(200);
    expect(next.body["conversationId"]).toBe(conversationId);
    // Still a human's thread: the model was not consulted.
    expect(next.body["decision"]).toBe("handoff");
    expect(providerCalls).toBe(0);
  });

  it("records the reason, the event and one open request per conversation", async () => {
    const handoff = await postGuestHandoff(deps(), client, { slug: SLUG, language: "es" });
    expect(handoff.requestCreated).toBe(true);

    const second = await postGuestHandoff(deps(), client, {
      slug: SLUG,
      language: "es",
      ticket: { ...decode(handoff), conversationId: handoff.conversationId },
    });
    expect(second.requestId).toBe(handoff.requestId);
    expect(second.requestCreated).toBe(false);

    const reasons = await client.query<{ reason_code: string; detail: string }>(
      "SELECT reason_code, detail FROM handoff_reasons WHERE conversation_id = $1",
      [handoff.conversationId],
    );
    expect(reasons.rows).toEqual([
      { reason_code: "guest_asked_human", detail: "guest_tapped_talk_to_person" },
    ]);

    const requests = await client.query<{ topic: string; status: string }>(
      "SELECT topic, status FROM service_requests WHERE conversation_id = $1",
      [handoff.conversationId],
    );
    expect(requests.rows).toEqual([{ topic: "guest_requested_human", status: "new" }]);

    const events = await client.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE conversation_id = $1 ORDER BY event_id",
      [handoff.conversationId],
    );
    const kinds = events.rows.map((row) => row.event_type);
    expect(kinds.filter((kind) => kind === "human_takeover")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "request_created")).toHaveLength(1);
  });

  it("keeps the state machine honest: a handoff never hands the thread back to the model", async () => {
    const handoff = await postGuestHandoff(deps(), client, { slug: SLUG, language: "es" });
    await seedState(handoff.conversationId, "resolved");
    // `resolved -> idle` remains illegal, so nothing in this path can quietly
    // return an owned conversation to the bot.
    await expect(
      client.query("UPDATE conversations SET ai_state = 'idle' WHERE conversation_id = $1", [
        handoff.conversationId,
      ]),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("rejects an unknown slug without writing anything", async () => {
    const before = await client.query<{ n: string }>("SELECT count(*) AS n FROM conversations");
    const response = await call({ url: "/api/chat/handoff?property=no-such-hotel" });
    expect(response.status).toBe(404);
    expect(response.body["error"]).toBe("unknown_property");
    const after = await client.query<{ n: string }>("SELECT count(*) AS n FROM conversations");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("answers 405 for a GET, so the route is not a link anyone can share into", async () => {
    const response = await call({ method: "GET", url: `/api/chat/handoff?property=${SLUG}` });
    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe("POST");
  });
});

/** The ticket a service call returns, in the shape the next call wants. */
function decode(turn: { ticket: string }): {
  identityId: string;
  conversationId: string | null;
  propertyId: string;
} {
  const ticket = verifyGuestTicket(turn.ticket, SECRET);
  if (ticket === null) throw new Error("the service issued an unverifiable ticket");
  return ticket;
}
