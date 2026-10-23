import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  AuthVerifyError,
  fakeIdentity,
  verifyIdentityToken,
  verifyWithJwk,
} from "../../src/auth/session.ts";

interface KeyMaterial {
  jwk: Record<string, unknown>;
  sign: (data: string) => Buffer;
}

const EC_JWK_ENTRY: KeyMaterial = (() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "test-ec-1";
  jwk.use = "sig";
  jwk.alg = "ES256";
  return { jwk, sign: (d) => crypto.sign("sha256", Buffer.from(d), privateKey) };
})();

const RSA_JWK_ENTRY: KeyMaterial = (() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "test-rsa-2";
  jwk.use = "sig";
  jwk.alg = "PS256";
  return { jwk, sign: (d) => crypto.sign("sha256", Buffer.from(d), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }) };
})();

const ED_JWK_ENTRY: KeyMaterial = (() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "test-ed-3";
  jwk.use = "sig";
  jwk.alg = "EdDSA";
  jwk.crv = "Ed25519";
  return { jwk, sign: (d) => crypto.sign(null, Buffer.from(d), privateKey) };
})();

function mint(entry: KeyMaterial, claims: Record<string, unknown> = {}, alg?: string): string {
  const header = { alg: alg ?? entry.jwk.alg, typ: "JWT", kid: entry.jwk.kid };
  const encoder = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${encoder(header)}.${encoder({
    sub: "auth0|507f1f77bcf86cd799439011",
    email: "gm@hotelparaiso.mx",
    name: "Front Manager",
    voice: "0xFF00FF",
    iss: "neon-auth",
    exp: 2_000_000_000,
    ...claims,
  })}`;
  const signature = entry.sign(signingInput).toString("base64url");
  return `${signingInput}.${signature}`;
}

describe("Neon Auth token verification (S02-01)", () => {
  it("binds identity to ES256-signed tokens", () => {
    const token = mint(EC_JWK_ENTRY);
    const identity = verifyWithJwk(token, EC_JWK_ENTRY.jwk as never, 1_000_000_000 + 7200);
    expect(identity.neonAuthUserId).toBe("auth0|507f1f77bcf86cd799439011");
    expect(identity.email).toBe("gm@hotelparaiso.mx");
    expect(identity.displayName).toBe("Front Manager");
  });

  it("refuses a token whose signature does not match the JWKS key", () => {
    const token = mint(EC_JWK_ENTRY);
    expect(() => verifyWithJwk(token, ED_JWK_ENTRY.jwk as never)).toThrow(AuthVerifyError);
  });

  it("refuses tokens without sub/email claims (despite a valid signature)", () => {
    const noEmail = mint(EC_JWK_ENTRY, { email: undefined });
    expect(() => verifyWithJwk(noEmail, EC_JWK_ENTRY.jwk as never)).toThrow(/email/);
    const noSub = mint(EC_JWK_ENTRY, { sub: undefined });
    expect(() => verifyWithJwk(noSub, EC_JWK_ENTRY.jwk as never)).toThrow(/sub/);
  });

  it("refuses expired tokens", () => {
    const token = mint(EC_JWK_ENTRY, { exp: 901 });
    expect(() => verifyWithJwk(token, EC_JWK_ENTRY.jwk as never, 1_000_000)).toThrow(/expired/);
  });

  it("accepts RSA-PSS and Ed25519 signers too", () => {
    const rsa = mint(RSA_JWK_ENTRY);
    expect(verifyWithJwk(rsa, RSA_JWK_ENTRY.jwk as never).email).toContain("hotel");
    const ed = mint(ED_JWK_ENTRY);
    expect(verifyWithJwk(ed, ED_JWK_ENTRY.jwk as never).displayName).toBe("Front Manager");
  });

  it("resolves keys by kid through the fake JWKS endpoint", async () => {
    const jwks = { keys: [RSA_JWK_ENTRY.jwk, EC_JWK_ENTRY.jwk] };
    const res = new Response(JSON.stringify(jwks), { status: 200 });
    const identity = await verifyIdentityToken(mint(EC_JWK_ENTRY), {
      url: "https://fake.jwks/jwks.json",
      fetch: (async () => res) as typeof fetch,
    });
    expect(identity.neonAuthUserId).toBe("auth0|507f1f77bcf86cd799439011");
  });

  it("refreshes once on an unknown kid, then fails", async () => {
    let calls = 0;
    const fetchJwks = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ keys: [RSA_JWK_ENTRY.jwk] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      verifyIdentityToken(mint(EC_JWK_ENTRY), { url: "https://fake.jwks/rotate.json", fetch: fetchJwks }),
    ).rejects.toThrow(/no JWKS key matched|signature verification failed/);
    expect(calls).toBe(2);
  });

  it("keeps fake identities available for db-layer tests", () => {
    expect(fakeIdentity().email).toBeTruthy();
  });

  it("treats a private JWK as attacker input", () => {
    const privateJwk = { ...EC_JWK_ENTRY.jwk } as Record<string, unknown>;
    expect(() => verifyWithJwk(mint(EC_JWK_ENTRY), { ...privateJwk, d: "AAA" } as never)).toThrow(/private-key/);
  });
});
