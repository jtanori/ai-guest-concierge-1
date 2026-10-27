/**
 * S06-01 — the public chat surface's HTTP seam.
 *
 * Three routes, all under `/api/chat`, all tenant-resolved from `?property=<slug>`:
 *
 *   GET  /api/chat/property   what the page needs before a guest types anything
 *   GET  /api/chat/messages   the cookie's transcript (empty for a new visitor)
 *   POST /api/chat/messages   one turn: inbound + outbound, atomically
 *   POST /api/chat/handoff    S07-02: one tap to a human, from any state
 *
 * The slug is part of the URL, never a body field. `x-org-id`/`x-property-id`
 * headers, `orgId`/`propertyId`/`conversationId` body fields and anything else a
 * client might try are ignored rather than rejected: a request that carries a
 * forged tenant is not an attack to be reported back to the attacker, it is a
 * request whose forged parts have no meaning here. `tests/db/guest-chat.db.test.ts`
 * asserts exactly that, by writing with a foreign property id in the body and
 * checking where the rows landed.
 *
 * Status mapping is one function, for the same reason the staff surface has one:
 * a client-side mistake maps to exactly one documented code.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import { LANGUAGES, type Lang } from "../i18n/catalog.ts";
import {
  GUEST_COOKIE,
  GuestConfigError,
  readCookie,
  serializeGuestCookie,
  verifyGuestTicket,
  type GuestTicket,
} from "./cookie.ts";
import {
  BotCheckFailedError,
  CardNumberRefusedError,
  GuestInputError,
  RateLimitedError,
  UnknownPropertyError,
  loadPublicProperty,
  loadTranscript,
  postGuestHandoff,
  postGuestMessage,
  type GuestDeps,
  type GuestHandoff,
  type GuestTranscript,
  type GuestTurn,
  type PublicPropertyView,
} from "./service.ts";
import { GuestRoleUnavailableError } from "./session.ts";
import { publicBaseUrl } from "./links.ts";
import { qrSvg } from "./qr.ts";

export interface GuestHttpDeps extends GuestDeps {
  client: pg.Client | pg.PoolClient;
}

const CHAT_PREFIX = "/api/chat";

/**
 * A route's answer when it is not JSON.
 *
 * The QR is the only `/api/chat` route that returns something other than a
 * document, and it returns it as `image/svg+xml`. Rather than teach `send()` to
 * sniff content types — which is how a JSON surface starts emitting whatever a
 * handler felt like — a handler may return this and the dispatcher writes it
 * verbatim.
 */
export class GuestRawResponse {
  // Fields are declared and assigned explicitly rather than written as
  // constructor parameter properties: the server runs under Node's
  // `--experimental-strip-types`, which refuses erasable-syntax violations like
  // parameter properties. It type-checks and runs under vitest either way, which
  // is exactly how this shipped once and failed on boot.
  readonly body: string;
  readonly contentType: string;
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(
    body: string,
    contentType: string,
    status = 200,
    headers: Record<string, string> = {},
  ) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

/**
 * S07-01 — the base URL for a link, from the one place that can know it.
 *
 * `GUEST_PUBLIC_URL` wins. Otherwise the caller's hint (the web tier, which knows
 * the public origin a guest is actually using) and finally this request's own
 * Host header — right for local dev, wrong behind a proxy, which is why the
 * env var exists.
 */
function linkBase(url: URL, req: IncomingMessage): string {
  const hint = url.searchParams.get("base");
  return publicBaseUrl(
    process.env["GUEST_PUBLIC_URL"],
    hint !== null && hint !== "" ? hint : `http://${req.headers.host ?? "localhost"}`,
  );
}
const MAX_BODY_BYTES = 16 * 1024;

/** True when this handler owns the path (so the health table never sees it). */
export function ownsGuestPath(path: string): boolean {
  return path === CHAT_PREFIX || path.startsWith(`${CHAT_PREFIX}/`);
}

export function classifyGuestError(error: unknown): {
  status: number;
  error: string;
  detail?: string;
  /** Extra response headers a client needs (S07-04: `Retry-After`). */
  headers?: Record<string, string>;
} {
  if (error instanceof UnknownPropertyError) return { status: 404, error: "unknown_property" };
  // S07-04 — 429 with a number, not 500 and not silence. A guest client that
  // gets a countdown can show it; a client that gets an opaque failure retries.
  if (error instanceof RateLimitedError) {
    return {
      status: 429,
      error: "rate_limited",
      detail: `bucket=${error.bucket} limit=${error.limit}`,
      headers: { "retry-after": String(error.retryAfterSeconds) },
    };
  }
  // 403, not 400: the request was well-formed, the client was not believed.
  if (error instanceof BotCheckFailedError) {
    return { status: 403, error: "bot_check_failed", detail: error.reason };
  }
  // S11-03 — 422, not 400: the request was well-formed and the client can fix it
  // by sending the message again without the number. The guest screen keys its
  // catalogue copy off this code, so the string is stable.
  if (error instanceof CardNumberRefusedError) {
    return { status: 422, error: "card_number_not_allowed" };
  }
  if (error instanceof GuestInputError) {
    return { status: 400, error: "invalid_message", detail: error.message };
  }
  if (error instanceof GuestRoleUnavailableError) {
    return { status: 503, error: "guest_lookup_unavailable", detail: error.message };
  }
  if (error instanceof GuestConfigError) {
    return { status: 503, error: "guest_config_unavailable", detail: error.message };
  }
  // Never echo an unexpected error: a driver message can carry the DSN.
  return { status: 500, error: "internal_error" };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new GuestInputError("request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GuestInputError("request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GuestInputError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** `?property=` is the only tenant input; anything else is ignored. */
export function slugFromUrl(url: URL): string {
  return (url.searchParams.get("property") ?? "").trim();
}

/** Explicit `?lang=`, else the browser's preference, else the property default. */
export function requestedLanguage(url: URL, headers: IncomingMessage["headers"]): Lang | null {
  const explicit = url.searchParams.get("lang");
  if (explicit !== null && (LANGUAGES as readonly string[]).includes(explicit)) return explicit as Lang;
  const accept = headers["accept-language"];
  const raw = Array.isArray(accept) ? accept[0] : accept;
  if (typeof raw === "string") {
    for (const part of raw.split(",")) {
      const code = part.split(";")[0]!.trim().slice(0, 2).toLowerCase();
      if ((LANGUAGES as readonly string[]).includes(code)) return code as Lang;
    }
  }
  return null;
}

function isSecure(req: IncomingMessage): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof value === "string") return value.split(",")[0]!.trim().toLowerCase() === "https";
  return (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
}

/**
 * S07-04 — the client address, as the proxy in front of us reported it.
 *
 * `x-forwarded-for` is a chain and only the FIRST hop is the client; the rest
 * are proxies we do not control, and trusting the last one would let a caller
 * choose its own bucket. The header is still caller-supplied on a host with no
 * trusted proxy, which is why the ip bucket is a flood speed-bump and the
 * property bucket (which cannot be spoofed) is the hard ceiling.
 */
export function clientIp(req: IncomingMessage): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === "string") {
    const first = raw.split(",")[0]!.trim();
    if (first !== "") return first;
  }
  const real = req.headers["x-real-ip"];
  const single = Array.isArray(real) ? real[0] : real;
  if (typeof single === "string" && single.trim() !== "") return single.trim();
  const socket = req.socket as { remoteAddress?: string } | undefined;
  return socket?.remoteAddress ?? null;
}

function ticketFrom(req: IncomingMessage, cookieSecret: string): GuestTicket | null {
  const raw = readCookie(req.headers.cookie, GUEST_COOKIE);
  if (raw === undefined) return null;
  return verifyGuestTicket(raw, cookieSecret);
}

function setTicket(res: ServerResponse, value: string, req: IncomingMessage): void {
  res.setHeader("set-cookie", serializeGuestCookie(value, { secure: isSecure(req) }));
  // The transcript is per-guest: no shared cache may keep it.
  res.setHeader("cache-control", "no-store");
}

type Route = {
  method: "GET" | "POST";
  pattern: RegExp;
  run: (url: URL, req: IncomingMessage, res: ServerResponse, deps: GuestHttpDeps) => Promise<unknown>;
};

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/chat\/property$/,
    run: (url, req, res, deps): Promise<PublicPropertyView> => {
      res.setHeader("cache-control", "public, max-age=60");
      return loadPublicProperty(deps.client, {
        slug: slugFromUrl(url),
        language: requestedLanguage(url, req.headers),
      });
    },
  },
  {
    // S07-01 AC-1 — the QR SVG is ENCODED HERE, not in the web tier.
    //
    // The Next project installs only `web/`'s dependencies (`.github/workflows/
    // ci.yml`, `web-build`), and `src/guest/qr.ts` needs `qrcode`; a route in
    // `web/` that imported the encoder built fine locally (root `node_modules`
    // present) and failed in CI (absent). Serving the image from the tier that
    // owns the slug lookup and the encoder removes the cross-project import
    // entirely, and the web route becomes a proxy — the same shape as
    // `/api/chat/property`.
    method: "GET",
    pattern: /^\/api\/chat\/qr\.svg$/,
    run: async (url, req, _res, deps): Promise<GuestRawResponse> => {
      const property = await loadPublicProperty(deps.client, {
        slug: slugFromUrl(url),
        language: requestedLanguage(url, req.headers),
      });
      const svg = await qrSvg({ baseUrl: linkBase(url, req), slug: property.slug });
      return new GuestRawResponse(svg, "image/svg+xml; charset=utf-8", 200, {
        // The payload never changes for a property, and a card does not get
        // re-scanned when the deploy rolls.
        "cache-control": "public, max-age=3600",
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/chat\/messages$/,
    run: (url, req, res, deps): Promise<GuestTranscript> => {
      res.setHeader("cache-control", "no-store");
      return loadTranscript(deps.client, {
        slug: slugFromUrl(url),
        language: requestedLanguage(url, req.headers),
        ticket: ticketFrom(req, deps.cookieSecret),
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/chat\/messages$/,
    run: async (url, req, res, deps): Promise<GuestTurn> => {
      const body = await readJson(req);
      // `orgId`, `propertyId`, `conversationId` and friends are deliberately
      // never read from `body`: the tenant is the slug below, and the
      // conversation is the signed cookie.
      const turn = await postGuestMessage(deps, deps.client, {
        slug: slugFromUrl(url),
        text: typeof body["text"] === "string" ? body["text"] : "",
        language: requestedLanguage(url, req.headers),
        ticket: ticketFrom(req, deps.cookieSecret),
        // S07-04: the address is read from the transport, never the body — a
        // client that could choose its own bucket would have no limit at all.
        ip: clientIp(req),
        turnstileToken:
          typeof body["turnstileToken"] === "string" ? body["turnstileToken"] : null,
      });
      setTicket(res, turn.ticket, req);
      return turn;
    },
  },
  {
    // S07-02 — "talk to a person". A POST with no body: the tenant is the slug,
    // the conversation is the cookie, and nothing else a client could send has
    // a meaning here. It deliberately does not take a message: a handoff that
    // needs typing is not one tap, and the model is never in this path.
    method: "POST",
    pattern: /^\/api\/chat\/handoff$/,
    run: async (url, req, res, deps): Promise<GuestHandoff> => {
      const handoff = await postGuestHandoff(deps, deps.client, {
        slug: slugFromUrl(url),
        language: requestedLanguage(url, req.headers),
        ticket: ticketFrom(req, deps.cookieSecret),
      });
      setTicket(res, handoff.ticket, req);
      return handoff;
    },
  },
];

/**
 * Handles one `/api/chat/*` request. Always writes a response; client-side
 * problems carry a status code rather than an exception.
 */
export async function handleGuestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GuestHttpDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = (req.method ?? "GET").toUpperCase();

  try {
    // Match the path first, then the verb: `/api/chat/messages` answers both GET
    // (transcript) and POST (one turn), and picking by pattern alone would 405 a
    // POST that has a handler.
    const candidates = ROUTES.filter((candidate) => candidate.pattern.test(url.pathname));
    if (candidates.length === 0) {
      send(res, 404, { error: "not_found", path: url.pathname });
      return;
    }
    const route = candidates.find((candidate) => candidate.method === method);
    if (route === undefined) {
      res.setHeader("allow", candidates.map((candidate) => candidate.method).join(", "));
      send(res, 405, { error: "method_not_allowed", method });
      return;
    }
    const body = await route.run(url, req, res, deps);
    if (body instanceof GuestRawResponse) {
      res.writeHead(body.status, {
        "content-type": body.contentType,
        ...body.headers,
        // Inert bytes, but nothing may sniff them into a document.
        "x-content-type-options": "nosniff",
      });
      res.end(body.body);
      return;
    }
    send(res, 200, body);
  } catch (error) {
    const failure = classifyGuestError(error);
    res.removeHeader("set-cookie");
    for (const [name, value] of Object.entries(failure.headers ?? {})) res.setHeader(name, value);
    send(res, failure.status, {
      error: failure.error,
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    });
  }
}
