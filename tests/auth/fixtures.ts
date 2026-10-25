/**
 * Shared JWT fixtures for the S02-01 suites.
 *
 * The signers reproduce what a real JWKS deployment does: JOSE fixed-width
 * r||s for ES256 (node's default DER is deliberately not used), PSS for
 * PS256, and raw Ed25519. Tests import the private key only through `sign`.
 */
import crypto from "node:crypto";

export interface SigningKey {
  jwk: Record<string, unknown>;
  sign: (data: string) => Buffer;
}

export const FIXED_NOW = 1_000_000_000;

export const TEST_VERIFY = {
  issuer: "neon-auth",
  audience: "concierge",
} as const;

export function ecKey(kid = "test-ec-1", alg = "ES256"): SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = alg;
  return {
    jwk,
    sign: (data) =>
      crypto.sign("sha256", Buffer.from(data), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }),
  };
}

export function rsaKey(kid = "test-rsa-2", alg: "RS256" | "PS256" = "PS256"): SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = alg;
  return {
    jwk,
    sign: (data) =>
      crypto.sign(
        "sha256",
        Buffer.from(data),
        alg === "PS256"
          ? {
              key: privateKey,
              padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
              saltLength: 32,
            }
          : privateKey,
      ),
  };
}

export function edKey(kid = "test-ed-3"): SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "EdDSA";
  jwk.crv = "Ed25519";
  return {
    jwk,
    sign: (data) => crypto.sign(null, Buffer.from(data), privateKey),
  };
}

export interface MintOptions {
  alg?: string;
  header?: Record<string, unknown>;
}

export function mint(
  key: SigningKey,
  claims: Record<string, unknown> = {},
  options: MintOptions = {},
): string {
  const header = {
    alg: options.alg ?? key.jwk.alg,
    typ: "JWT",
    kid: key.jwk.kid,
    ...options.header,
  };
  const payload = {
    sub: "auth0|507f1f77bcf86cd799439011",
    email: "gm@hotelparaiso.mx",
    name: "Front Manager",
    email_verified: true,
    iss: TEST_VERIFY.issuer,
    aud: TEST_VERIFY.audience,
    nbf: FIXED_NOW - 10,
    iat: FIXED_NOW - 10,
    exp: FIXED_NOW + 7200,
    ...claims,
  };
  const encoder = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encoder(header)}.${encoder(payload)}`;
  return `${signingInput}.${key.sign(signingInput).toString("base64url")}`;
}

/** Live-window claims for DB suites (the fixed fixture clock is long past). */
export function liveClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { nbf: now - 10, iat: now - 10, exp: now + 3600, ...overrides };
}
