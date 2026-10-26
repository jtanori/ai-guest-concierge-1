/**
 * S06-01 — the guest HTTP seam's pure half: routing, tenant extraction (slug,
 * never body), status mapping, and the one degradation path that must not be a
 * 500.
 *
 * A fake client makes the "no database work" claims literal: any query it sees
 * is either expected (BEGIN/ROLLBACK on a rejected slug) or a test failure.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { withResilience } from "../../src/ai/provider.ts";
import {
  classifyGuestError,
  handleGuestRequest,
  ownsGuestPath,
  requestedLanguage,
  slugFromUrl,
  type GuestHttpDeps,
} from "../../src/guest/http.ts";
import { GuestConfigError } from "../../src/guest/cookie.ts";
import { GuestInputError, UnknownPropertyError } from "../../src/guest/service.ts";
import { GuestRoleUnavailableError } from "../../src/guest/session.ts";

const SECRET = "s".repeat(32);

function ai() {
  // Distinct model ids: withResilience refuses a "fallback" that is the same
  // model, which is the right refusal and has its own test in tests/ai.
  return withResilience(
    createFixedProvider({}, "stub-primary-2026-01-01"),
    createFixedProvider({}, "stub-fallback-2026-01-01"),
    {
    retries: 0,
    sleep: async () => {},
    now: () => 0,
    },
  );
}

/** Records every statement; `query` never resolves with rows. */
function fakeClient(queries: string[] = []) {
  return {
    queries,
    query: (text: string) => {
      queries.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as GuestHttpDeps["client"] & { queries: string[] };
}

function deps(overrides: Partial<GuestHttpDeps> = {}): GuestHttpDeps {
  const client = fakeClient();
  return {
    client,
    cookieSecret: SECRET,
    ai: ai(),
    ...overrides,
  };
}

interface Fake {
  req: IncomingMessage;
  res: ServerResponse;
  status(): number;
  body(): Record<string, unknown>;
  header(name: string): string | undefined;
}

function roundTrip(
  options: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Fake {
  const handlers: Array<[string, unknown]> = [];
  const headers: Record<string, string> = {};
  let status = 200;
  let payload = "";
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
    },
    on: (event: string, handler: unknown) => {
      handlers.push([event, handler]);
    },
  } as unknown as ServerResponse;

  const body = options.body ?? "";
  const req = {
    method: options.method ?? "GET",
    url: options.url ?? "/",
    headers: options.headers ?? {},
    socket: {},
    async *[Symbol.asyncIterator]() {
      if (body !== "") yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;

  return {
    req,
    res,
    status: () => status,
    body: () => (payload === "" ? {} : (JSON.parse(payload) as Record<string, unknown>)),
    header: (name: string) => headers[name.toLowerCase()],
  };
}

describe("guest surface: routing and tenant extraction (S06-01)", () => {
  it("owns /api/chat and nothing else", () => {
    expect(ownsGuestPath("/api/chat")).toBe(true);
    expect(ownsGuestPath("/api/chat/messages")).toBe(true);
    expect(ownsGuestPath("/api/review/queue")).toBe(false);
    expect(ownsGuestPath("/healthz")).toBe(false);
    expect(ownsGuestPath("/api/chatter")).toBe(false);
  });

  it("takes the tenant from the query string only", () => {
    expect(slugFromUrl(new URL("http://x/api/chat/messages?property=demo"))).toBe("demo");
    expect(slugFromUrl(new URL("http://x/api/chat/messages?property=%20demo%20"))).toBe("demo");
    expect(slugFromUrl(new URL("http://x/api/chat/messages"))).toBe("");
  });

  it("prefers an explicit lang, then Accept-Language, then nothing", () => {
    expect(requestedLanguage(new URL("http://x/?lang=en"), {})).toBe("en");
    expect(requestedLanguage(new URL("http://x/?lang=fr"), {})).toBeNull();
    expect(requestedLanguage(new URL("http://x/"), { "accept-language": "en-GB,en;q=0.9" })).toBe("en");
    expect(requestedLanguage(new URL("http://x/"), { "accept-language": "fr-FR,fr;q=0.8" })).toBeNull();
    expect(requestedLanguage(new URL("http://x/"), {})).toBeNull();
  });

  it("maps one error to one status, and never leaks an unexpected one", () => {
    expect(classifyGuestError(new UnknownPropertyError("nope"))).toEqual({
      status: 404,
      error: "unknown_property",
    });
    expect(classifyGuestError(new GuestInputError("empty")).status).toBe(400);
    expect(classifyGuestError(new GuestConfigError("no secret"))).toEqual({
      status: 503,
      error: "guest_config_unavailable",
      detail: "no secret",
    });
    expect(classifyGuestError(new GuestRoleUnavailableError("permission denied")).status).toBe(503);
    expect(classifyGuestError(new Error("postgres://user:pw@host/db"))).toEqual({
      status: 500,
      error: "internal_error",
    });
  });
});

describe("guest surface: one request (S06-01)", () => {
  it("answers 404 for a path it does not serve", async () => {
    const call = roundTrip({ url: "/api/chat/nope?property=demo" });
    await handleGuestRequest(call.req, call.res, deps());
    expect(call.status()).toBe(404);
    expect(call.body()["error"]).toBe("not_found");
  });

  it("answers 405 for the wrong verb and names the right one", async () => {
    const call = roundTrip({ method: "PUT", url: "/api/chat/messages?property=demo" });
    await handleGuestRequest(call.req, call.res, deps());
    expect(call.status()).toBe(405);
    expect(call.header("allow")).toBe("GET, POST");
  });

  it("rejects an empty message before it opens a transaction", async () => {
    const client = fakeClient();
    const call = roundTrip({
      method: "POST",
      url: "/api/chat/messages?property=demo",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    await handleGuestRequest(call.req, call.res, deps({ client }));
    expect(call.status()).toBe(400);
    expect(call.body()["error"]).toBe("invalid_message");
    // Nothing touched the database: validation is the first statement.
    expect((client as unknown as { queries: string[] }).queries).toEqual([]);
  });

  it("404s a malformed slug without a query, and never with a 400", async () => {
    const client = fakeClient();
    const call = roundTrip({ url: "/api/chat/property?property=Not%20A%20Slug" });
    await handleGuestRequest(call.req, call.res, deps({ client }));
    expect(call.status()).toBe(404);
    expect((client as unknown as { queries: string[] }).queries).toEqual([]);
  });

  it("rejects a body that is not JSON at all", async () => {
    const call = roundTrip({
      method: "POST",
      url: "/api/chat/messages?property=demo",
      body: "text=hola",
    });
    await handleGuestRequest(call.req, call.res, deps());
    expect(call.status()).toBe(400);
  });
});
