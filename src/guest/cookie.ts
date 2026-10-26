/**
 * S06-01 — the anonymous guest ticket.
 *
 * A guest has no account, so the only thing that can say "this is the same
 * stranger as two minutes ago" is a token the browser cannot forge and cannot
 * read. It is an HttpOnly cookie whose value is `base64url(payload).base64url(HMAC)`.
 *
 * Three rules, each one a test:
 *
 *  - **Signed, not encrypted.** The payload is not secret (it holds three UUIDs
 *    that mean nothing without the tenant transaction); what matters is that it
 *    cannot be EDITED. A guest who changes the conversation id invalidates the
 *    signature and gets a new conversation — never somebody else's.
 *  - **Scoped to a property.** The payload carries `propertyId`, and the service
 *    refuses a ticket whose property differs from the slug's. Without that,
 *    a ticket harvested on hotel A's page would address hotel A's conversation
 *    from hotel B's URL.
 *  - **No personal data.** No IP, no user agent, no email — the cookie exists
 *    for continuity, not for tracking, and it holds nothing a guest would not
 *    expect to be in a chat session.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const GUEST_COOKIE = "concierge_guest";
export const GUEST_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;

/** Claims that survive a round trip through the browser. */
export interface GuestTicket {
  /** `channel_identities.identity_id` — the anonymous guest. */
  identityId: string;
  /** `conversations.conversation_id`, or null before the first message. */
  conversationId: string | null;
  /** The property the ticket was issued for. Never trusted for routing. */
  propertyId: string;
}

export class GuestConfigError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cookie secret shorter than 32 bytes is a guess away from being no secret. */
export const MIN_SECRET_LENGTH = 32;

export interface GuestConfig {
  cookieSecret: string;
}

/**
 * `GUEST_COOKIE_SECRET` is required, not defaulted: a default would be a
 * published signing key. The server treats a missing secret like any other
 * unconfigured host — 503 with a reason, never a predictably-signed cookie.
 */
export function loadGuestConfig(source: NodeJS.ProcessEnv): GuestConfig {
  const secret = (source["GUEST_COOKIE_SECRET"] ?? "").trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new GuestConfigError(
      `GUEST_COOKIE_SECRET is required and must be at least ${MIN_SECRET_LENGTH} characters ` +
        "(the guest identity cookie is signed with it; a default would be a published key)",
    );
  }
  return { cookieSecret: secret };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signGuestTicket(ticket: GuestTicket, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ i: ticket.identityId, c: ticket.conversationId, p: ticket.propertyId }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns null for anything that is not a ticket this server signed. */
export function verifyGuestTicket(value: string, secret: string): GuestTicket | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const payload = value.slice(0, dot);
  const provided = value.slice(dot + 1);

  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(provided);
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // exception itself would be a (tiny) oracle.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const claims = parsed as { i?: unknown; c?: unknown; p?: unknown };
  if (typeof claims.i !== "string" || !UUID_RE.test(claims.i)) return null;
  if (typeof claims.p !== "string" || !UUID_RE.test(claims.p)) return null;
  if (claims.c !== null && (typeof claims.c !== "string" || !UUID_RE.test(claims.c))) return null;
  return { identityId: claims.i, conversationId: claims.c as string | null, propertyId: claims.p };
}

/** One cookie header → one value, or undefined. Order-insensitive, no parse deps. */
export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (typeof raw !== "string" || raw === "") return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * `Secure` is set from the request's scheme, not from APP_ENV: a preview host
 * serves HTTPS and the cookie must travel only over it, while local dev is
 * plain HTTP and a Secure cookie would silently never come back.
 */
export function serializeGuestCookie(
  value: string,
  options: { secure: boolean; maxAgeSeconds?: number },
): string {
  const parts = [
    `${GUEST_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds ?? GUEST_COOKIE_MAX_AGE_S}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}
