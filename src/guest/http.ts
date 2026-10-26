/**
 * S06-01 — the public chat surface's HTTP seam.
 *
 * Three routes, all under `/api/chat`, all tenant-resolved from `?property=<slug>`:
 *
 *   GET  /api/chat/property   what the page needs before a guest types anything
 *   GET  /api/chat/messages   the cookie's transcript (empty for a new visitor)
 *   POST /api/chat/messages   one turn: inbound + outbound, atomically
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
  GuestInputError,
  UnknownPropertyError,
  loadPublicProperty,
  loadTranscript,
  postGuestMessage,
  type GuestDeps,
  type GuestTranscript,
  type GuestTurn,
  type PublicPropertyView,
} from "./service.ts";
import { GuestRoleUnavailableError } from "./session.ts";

export interface GuestHttpDeps extends GuestDeps {
  client: pg.Client | pg.PoolClient;
}

const CHAT_PREFIX = "/api/chat";
const MAX_BODY_BYTES = 16 * 1024;

/** True when this handler owns the path (so the health table never sees it). */
export function ownsGuestPath(path: string): boolean {
  return path === CHAT_PREFIX || path.startsWith(`${CHAT_PREFIX}/`);
}

export function classifyGuestError(error: unknown): {
  status: number;
  error: string;
  detail?: string;
} {
  if (error instanceof UnknownPropertyError) return { status: 404, error: "unknown_property" };
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
      });
      setTicket(res, turn.ticket, req);
      return turn;
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
    send(res, 200, await route.run(url, req, res, deps));
  } catch (error) {
    const failure = classifyGuestError(error);
    res.removeHeader("set-cookie");
    send(res, failure.status, {
      error: failure.error,
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    });
  }
}
