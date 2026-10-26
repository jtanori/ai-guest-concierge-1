/**
 * S06-01 — the guest ticket, as a pure unit: signing, tampering, scoping, and
 * the cookie attributes that decide whether the browser may read it.
 *
 * No database: this is the part an attacker gets to see.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GUEST_COOKIE,
  GuestConfigError,
  MIN_SECRET_LENGTH,
  loadGuestConfig,
  readCookie,
  serializeGuestCookie,
  signGuestTicket,
  verifyGuestTicket,
} from "../../src/guest/cookie.ts";

const SECRET = "x".repeat(MIN_SECRET_LENGTH);
const IDENTITY = "11111111-1111-5111-a111-111111111111";
const CONVERSATION = "22222222-2222-5222-a222-222222222222";
const PROPERTY = "33333333-3333-5333-a333-333333333333";

const ticket = { identityId: IDENTITY, conversationId: CONVERSATION, propertyId: PROPERTY };

describe("guest ticket (S06-01)", () => {
  it("round-trips the three claims it is allowed to carry", () => {
    expect(verifyGuestTicket(signGuestTicket(ticket, SECRET), SECRET)).toEqual(ticket);
  });

  it("carries a null conversation before the first message", () => {
    const fresh = { ...ticket, conversationId: null };
    expect(verifyGuestTicket(signGuestTicket(fresh, SECRET), SECRET)).toEqual(fresh);
  });

  it("rejects an edited payload — a forged conversation id is not a session", () => {
    const value = signGuestTicket(ticket, SECRET);
    const [payload, signature] = value.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, string>;
    claims["c"] = "44444444-4444-5444-a444-444444444444";
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    expect(verifyGuestTicket(forged, SECRET)).toBeNull();
  });

  it("rejects a ticket signed with another secret", () => {
    const other = "y".repeat(MIN_SECRET_LENGTH);
    expect(verifyGuestTicket(signGuestTicket(ticket, other), SECRET)).toBeNull();
  });

  it("rejects garbage without throwing", () => {
    for (const value of ["", "abc", "abc.", ".abc", "a.b", "!!!!.????"]) {
      expect(verifyGuestTicket(value, SECRET)).toBeNull();
    }
  });

  it("rejects a correctly signed payload whose claims are not uuids", () => {
    const payload = Buffer.from(
      JSON.stringify({ i: "not-a-uuid", c: null, p: PROPERTY }),
    ).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(verifyGuestTicket(`${payload}.${signature}`, SECRET)).toBeNull();
  });

  it("requires a secret, and a long one", () => {
    expect(() => loadGuestConfig({})).toThrow(GuestConfigError);
    expect(() => loadGuestConfig({ GUEST_COOKIE_SECRET: "short" })).toThrow(/at least 32/);
    expect(loadGuestConfig({ GUEST_COOKIE_SECRET: SECRET }).cookieSecret).toBe(SECRET);
  });

  it("reads its own cookie out of a header with several", () => {
    const header = `staff_lang=es; ${GUEST_COOKIE}=abc.def; staff_token=t`;
    expect(readCookie(header, GUEST_COOKIE)).toBe("abc.def");
    expect(readCookie(undefined, GUEST_COOKIE)).toBeUndefined();
    expect(readCookie("other=1", GUEST_COOKIE)).toBeUndefined();
  });

  it("is HttpOnly and SameSite, and Secure only when the request was https", () => {
    const plain = serializeGuestCookie("v", { secure: false });
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Lax");
    expect(plain).not.toContain("Secure");
    expect(serializeGuestCookie("v", { secure: true })).toContain("Secure");
  });
});
