import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  AuthConfigError,
  AuthVerifyError,
  loadAuthConfig,
  verifyIdentityToken,
  verifyWithJwk,
} from "../../src/auth/session.ts";
import {
  ecKey,
  edKey,
  FIXED_NOW,
  liveClaims,
  mint,
  rsaKey,
  TEST_VERIFY,
} from "./fixtures.ts";

const OPTIONS = { ...TEST_VERIFY, nowEpoch: FIXED_NOW };
const EC = ecKey();
const RSA = rsaKey();
const ED = edKey();

function verify(token: string, jwk: Record<string, unknown> = EC.jwk) {
  return verifyWithJwk(token, jwk as never, OPTIONS);
}

describe("Neon Auth token verification (S02-01)", () => {
  it("binds identity to ES256-signed tokens", () => {
    const identity = verify(mint(EC));
    expect(identity.neonAuthUserId).toBe("auth0|507f1f77bcf86cd799439011");
    expect(identity.email).toBe("gm@hotelparaiso.mx");
    expect(identity.displayName).toBe("Front Manager");
    expect(identity.expiresAt).toBe(FIXED_NOW + 7200);
  });

  it("refuses a token whose signature does not match the JWKS key", () => {
    const sameKidDifferentKey = ecKey("test-ec-1");
    expect(() => verify(mint(EC), sameKidDifferentKey.jwk)).toThrow(/signature/);
  });

  it("refuses tokens without sub/email claims (despite a valid signature)", () => {
    expect(() => verify(mint(EC, { email: undefined }))).toThrow(/email/);
    expect(() => verify(mint(EC, { sub: undefined }))).toThrow(/sub/);
  });

  it("refuses expired tokens and accepts a small clock skew", () => {
    expect(() => verify(mint(EC, { exp: FIXED_NOW - 120 }))).toThrow(/expired/);
    expect(verify(mint(EC, { exp: FIXED_NOW - 30 })).email).toContain("hotel");
  });

  it("accepts RSA-PSS and Ed25519 signers too", () => {
    expect(verify(mint(RSA), RSA.jwk).email).toContain("hotel");
    expect(verify(mint(ED), ED.jwk).displayName).toBe("Front Manager");
  });

  it("resolves keys by kid through the fake JWKS endpoint", async () => {
    const jwks = { keys: [RSA.jwk, EC.jwk] };
    const res = new Response(JSON.stringify(jwks), { status: 200 });
    const identity = await verifyIdentityToken(mint(EC), {
      url: "https://fake.jwks/jwks.json",
      fetch: (async () => res) as typeof fetch,
    }, OPTIONS);
    expect(identity.neonAuthUserId).toBe("auth0|507f1f77bcf86cd799439011");
  });

  it("refreshes once on an unknown kid, then fails", async () => {
    let calls = 0;
    const fetchJwks = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ keys: [RSA.jwk] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      verifyIdentityToken(
        mint(EC),
        { url: "https://fake.jwks/rotate.json", fetch: fetchJwks },
        OPTIONS,
      ),
    ).rejects.toThrow(/no JWKS key matched|signature verification failed/);
    expect(calls).toBe(2);
  });

  it("requires a kid in the token header", async () => {
    const token = mint(EC, {}, { header: { kid: undefined } });
    await expect(
      verifyIdentityToken(
        token,
        { url: "https://fake.jwks/no-kid.json", fetch: (async () =>
          new Response(JSON.stringify({ keys: [EC.jwk] }), { status: 200 })) as typeof fetch },
        OPTIONS,
      ),
    ).rejects.toThrow(/kid/);
  });

  it("treats a private JWK as attacker input", () => {
    expect(() => verify(mint(EC), { ...EC.jwk, d: "AAA" })).toThrow(/private-key/);
  });

  it("binds the JWK to the token alg/kid/use/key_ops (review round 2)", () => {
    const token = mint(EC);
    expect(() => verify(token, { ...EC.jwk, kid: "other" })).toThrow(/kid/);
    expect(() => verify(token, { ...EC.jwk, alg: "RS256" })).toThrow(/alg/);
    expect(() => verify(token, { ...EC.jwk, kty: "RSA" })).toThrow(/type/);
    expect(() => verify(token, { ...EC.jwk, crv: "P-384" })).toThrow(/curve/);
    expect(() => verify(token, { ...EC.jwk, use: "enc" })).toThrow(/signing key/);
    expect(() => verify(token, { ...EC.jwk, key_ops: ["encrypt"] })).toThrow(/key_ops/);
  });

  it("accepts a real-Neon-shaped key (no use/key_ops, EdDSA/OKP)", () => {
    const bare = { ...ED.jwk };
    delete bare["use"];
    expect(verify(mint(ED), bare).email).toContain("hotel");
  });

  it("rejects non-JOSE ES256 signatures (DER and truncated r||s)", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    jwk.kid = "der-key";
    jwk.alg = "ES256";
    jwk.use = "sig";

    const encoder = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encoder({ alg: "ES256", typ: "JWT", kid: "der-key" });
    const payload = encoder({
      sub: "auth0|507f1f77bcf86cd799439011",
      email: "gm@hotelparaiso.mx",
      email_verified: true,
      iss: TEST_VERIFY.issuer,
      aud: TEST_VERIFY.audience,
      exp: FIXED_NOW + 7200,
    });
    const signingInput = `${header}.${payload}`;

    const der = crypto.sign("sha256", Buffer.from(signingInput), privateKey);
    expect(() =>
      verify(`${signingInput}.${der.toString("base64url")}`, jwk),
    ).toThrow(/64-byte JOSE/);

    const jose = crypto.sign("sha256", Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    const truncated = jose.subarray(0, 63);
    expect(() =>
      verify(`${signingInput}.${truncated.toString("base64url")}`, jwk),
    ).toThrow(/64-byte JOSE/);
  });

  it("validates iss/aud/nbf/iat/exp/email_verified claims (review round 2)", () => {
    expect(() => verify(mint(EC, { iss: "someone-else" }))).toThrow(/issuer/);
    expect(() => verify(mint(EC, { aud: "another-app" }))).toThrow(/audience/);
    expect(
      verify(mint(EC, { aud: ["other", TEST_VERIFY.audience] })).email,
    ).toContain("hotel");
    expect(() => verify(mint(EC, { nbf: FIXED_NOW + 600 }))).toThrow(/nbf/);
    expect(() => verify(mint(EC, { iat: FIXED_NOW + 600 }))).toThrow(/iat/);
    expect(() => verify(mint(EC, { exp: "soon" }))).toThrow(/exp/);
    expect(() => verify(mint(EC, { exp: Number.POSITIVE_INFINITY }))).toThrow(/exp/);
    expect(() => verify(mint(EC, { email_verified: false }))).toThrow(/verified/);
    expect(() => verify(mint(EC, { email_verified: undefined }))).toThrow(/verified/);
    expect(verify(mint(EC, { emailVerified: true })).email).toContain("hotel");
  });

  it("rejects malformed tokens", () => {
    expect(() => verify("not-a-jwt")).toThrow(AuthVerifyError);
    expect(() => verify("a.b.c")).toThrow(AuthVerifyError);
  });

  it("derives the auth client from env with explicit issuer/audience overrides", () => {
    const base = "https://branch.neonauth.example/neondb/auth";
    expect(
      loadAuthConfig({
        NEON_AUTH_BASE_URL: base,
        NEON_AUTH_JWKS_URL: `${base}/.well-known/jwks.json`,
      }),
    ).toEqual({
      url: `${base}/.well-known/jwks.json`,
      issuer: base,
      audience: base,
    });
    expect(
      loadAuthConfig({
        NEON_AUTH_BASE_URL: base,
        NEON_AUTH_JWKS_URL: `${base}/.well-known/jwks.json`,
        NEON_AUTH_ISSUER: "https://issuer.example",
        NEON_AUTH_AUDIENCE: "concierge-web",
      }),
    ).toMatchObject({ issuer: "https://issuer.example", audience: "concierge-web" });
    expect(() => loadAuthConfig({ NEON_AUTH_BASE_URL: base })).toThrow(AuthConfigError);
    expect(() =>
      loadAuthConfig({ NEON_AUTH_JWKS_URL: "https://x/jwks.json" }),
    ).toThrow(AuthConfigError);
  });

  it("treats empty strings as absent — the oneOf group's CI form (W00-13)", () => {
    // A workflow mapping `NEON_AUTH_ISSUER: ${{ vars.NEON_AUTH_ISSUER }}` for an
    // Environment that does not set the variable puts an EMPTY STRING in the job
    // env. `??` never falls back on "" (only on undefined), so the loader once
    // threw while the file-based readiness check — where the name is simply
    // absent — passed. Presence means non-empty, here and in the contract.
    const base = "https://branch.neonauth.example/neondb/auth";
    const jwks = `${base}/.well-known/jwks.json`;
    expect(
      loadAuthConfig({
        NEON_AUTH_ISSUER: "",
        NEON_AUTH_BASE_URL: base,
        NEON_AUTH_JWKS_URL: jwks,
      }),
    ).toEqual({ url: jwks, issuer: base, audience: base });
    expect(
      loadAuthConfig({
        NEON_AUTH_ISSUER: "  ",
        NEON_AUTH_BASE_URL: base,
        NEON_AUTH_JWKS_URL: jwks,
        NEON_AUTH_AUDIENCE: "",
      }),
    ).toMatchObject({ issuer: base, audience: base });
    expect(() =>
      loadAuthConfig({ NEON_AUTH_ISSUER: "", NEON_AUTH_BASE_URL: "", NEON_AUTH_JWKS_URL: jwks }),
    ).toThrow(AuthConfigError);
  });

  it("exposes live-window claims for DB suites", () => {
    const claims = liveClaims();
    expect(claims["exp"]).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
