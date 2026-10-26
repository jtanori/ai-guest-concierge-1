/**
 * S06-01 — a stranger holds a full conversation over real HTTP.
 *
 * The other guest suites prove the pieces (routing, cookie, tenancy). This one
 * puts them behind an actual `http.createServer` and talks to it with `fetch`,
 * because two things only break at that seam:
 *
 *  - **the cookie round trip** — `Set-Cookie` on the first turn has to come back
 *    on the second, or every message would start a new conversation;
 *  - **the wire shapes** — JSON in, JSON out, with the transcript readable
 *    afterwards by a client that kept nothing but the cookie.
 *
 * The provider is the stub, so this runs in CI with no key and no cost. That is
 * also the honest limit of the claim: this proves the surface works, not that
 * staging is reachable (recorded in the runbook).
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createScriptedProvider } from "../../src/ai/stub.ts";
import { handleGuestRequest, type GuestHttpDeps } from "../../src/guest/http.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

const SECRET = "h".repeat(40);
const SLUG = "http-hotel";

let client: pg.Client;
let server: Server;
let base: string;

const answer = {
  decision: "no_answer",
  answer: null,
  language: "es-MX",
  citations: [],
  reason_code: "low_retrieval",
  topic_keys_used: [],
  confidence: 0.2,
};

describe("guest chat over HTTP (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const org = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('HTTP', 'http-org') RETURNING org_id",
    );
    const property = await client.query<{ property_id: string }>(
      `INSERT INTO properties (org_id, name, slug, time_zone, settings)
       VALUES ($1, 'Hotel HTTP', $2, 'UTC', '{}'::jsonb) RETURNING property_id`,
      [org.rows[0]!.org_id, SLUG],
    );
    expect(property.rowCount).toBe(1);

    const deps: GuestHttpDeps = {
      client,
      cookieSecret: SECRET,
      ai: withResilience(
        createScriptedProvider([answer], "stub-primary-2026-01-01"),
        createScriptedProvider([answer], "stub-fallback-2026-01-01"),
        { retries: 0, sleep: async () => {}, now: () => 0 },
      ),
      now: () => new Date("2026-10-25T18:00:00Z"),
    };

    server = createServer((req, res) => {
      void handleGuestRequest(req, res, deps);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.close();
    await once(server, "close");
    await client.end();
    await dropScratch();
  });

  it("serves the property, holds two turns on one cookie, then replays them", async () => {
    const propertyResponse = await fetch(`${base}/api/chat/property?property=${SLUG}`);
    expect(propertyResponse.status).toBe(200);
    const property = (await propertyResponse.json()) as {
      name: string;
      disclosure: string;
      talkToPerson: string;
    };
    expect(property.name).toBe("Hotel HTTP");
    expect(property.disclosure).toMatch(/conserje|concierge/i);
    expect(property.talkToPerson).not.toBe("");

    const first = await fetch(`${base}/api/chat/messages?property=${SLUG}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hola, ¿tienen estacionamiento?" }),
    });
    expect(first.status).toBe(200);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("concierge_guest=");
    const firstBody = (await first.json()) as {
      conversationId: string;
      messages: Array<{ body: string; direction: string }>;
    };
    expect(firstBody.messages).toHaveLength(2);

    const second = await fetch(`${base}/api/chat/messages?property=${SLUG}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "Gracias" }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { conversationId: string };
    expect(secondBody.conversationId).toBe(firstBody.conversationId);

    // Only the cookie came back from the browser's side of the conversation.
    const replay = await fetch(`${base}/api/chat/messages?property=${SLUG}`, {
      headers: { cookie },
    });
    expect(replay.status).toBe(200);
    const transcript = (await replay.json()) as {
      messages: Array<{ direction: string }>;
    };
    expect(transcript.messages.map((message) => message.direction)).toEqual([
      "inbound",
      "outbound",
      "inbound",
      "outbound",
    ]);
  });

  it("404s an unknown property over the wire, and 405s the wrong verb", async () => {
    // A well-formed message to a slug nobody owns: the tenant is resolved before
    // anything is written, so the answer is 404 and the body carries no detail.
    const unknown = await fetch(`${base}/api/chat/messages?property=nope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hola" }),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown_property");
    expect((await fetch(`${base}/api/chat/property?property=${SLUG}`, { method: "DELETE" })).status).toBe(
      405,
    );
  });
});
