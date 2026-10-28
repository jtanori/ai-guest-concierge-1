/**
 * S02-01 — staff identity (D1's auth half).
 *
 * The provider is Neon Auth (managed Better Auth). Our contract with it is
 * deliberately narrow: a bearer JWT whose signature verifies against the
 * branch JWKS endpoint (NEON_AUTH_* env, probed in W00). Claims we bind:
 * `sub` (the Neon Auth user id), `email` (provisioned users row), issuer,
 * audience, validity window and a verified email. Roles are NEVER taken from
 * tokens or request bodies — they resolve from `memberships` under RLS
 * (db/migrations/0004_auth.sql).
 *
 * Verification uses node:crypto only. A JWK is accepted ONLY when it is
 * structurally bound to the token: same kid, same alg, matching kty/crv
 * (ES256→EC/P-256, RS256/PS256→RSA, EdDSA→OKP/Ed25519), no private `d`, and
 * no conflicting `use`/`key_ops`. ES256 signatures must be the JOSE
 * fixed-width r||s form (64 bytes) — DER is rejected, never coerced.
 */
import crypto from "node:crypto";

const IDENTITY_BRAND: unique symbol = Symbol("StaffIdentity");

/**
 * A JWKS-verified identity. The brand is a module-private symbol: the only
 * way to obtain one is verifyWithJwk/verifyIdentityToken, so a structurally
 * identical object literal cannot be passed off as a session
 * (review round 2, 4369257035).
 */
export interface StaffIdentity {
  readonly [IDENTITY_BRAND]: true;
  /** Neon Auth `sub` — idempotently mapped to users.neon_auth_user_id. */
  readonly neonAuthUserId: string;
  readonly email: string;
  readonly displayName: string | null;
  /** seconds — used by the caller to build the session record. */
  readonly expiresAt: number;
}

export class AuthVerifyError extends Error {}
export class AuthConfigError extends Error {}

interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  d?: string;
  use?: string;
  key_ops?: unknown;
}

export interface VerifyOptions {
  issuer: string;
  audience: string | readonly string[];
  /** Override for tests; seconds since epoch. */
  nowEpoch?: number;
  /** Allowed clock drift for exp/nbf/iat; defaults to 60s. */
  clockSkewSeconds?: number;
}

export interface JwksClient {
  url: string;
  fetch?: typeof fetch;
}

/** The env-derived pieces verifyIdentityToken needs. */
export interface AuthClientConfig extends JwksClient {
  issuer: string;
  audience: string;
}

export function isStaffIdentity(value: unknown): value is StaffIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [IDENTITY_BRAND]?: unknown })[IDENTITY_BRAND] === true
  );
}

function makeIdentity(
  neonAuthUserId: string,
  email: string,
  displayName: string | null,
  expiresAt: number,
): StaffIdentity {
  return {
    [IDENTITY_BRAND]: true,
    neonAuthUserId,
    email,
    displayName,
    expiresAt,
  };
}

/** Decoding + claim validation. Signature per key follows below. */
function decodeSegment(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new AuthVerifyError("malformed token segment");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AuthVerifyError("malformed token segment");
  }
  return parsed as Record<string, unknown>;
}

export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthVerifyError("malformed token");
  const [h, p, s] = parts as [string, string, string];
  let signature: Buffer;
  try {
    signature = Buffer.from(s, "base64url");
  } catch {
    throw new AuthVerifyError("malformed signature");
  }
  const header = decodeSegment(h);
  const payload = decodeSegment(p);
  return { header, payload, signingInput: `${h}.${p}`, signature };
}

function extractIdentity(
  payload: Record<string, unknown>,
  options: VerifyOptions,
): StaffIdentity {
  const now = options.nowEpoch ?? Date.now() / 1000;
  const skew = options.clockSkewSeconds ?? 60;

  const sub = payload["sub"];
  const email = payload["email"];
  if (typeof sub !== "string" || sub.length === 0) throw new AuthVerifyError("missing sub claim");
  if (typeof email !== "string" || email.length === 0) throw new AuthVerifyError("missing email claim");

  // Better Auth emits `emailVerified`; JWT-standard deployments use
  // `email_verified`. Accept either spelling, but only an explicit true.
  const verified = payload["email_verified"] ?? payload["emailVerified"];
  if (verified !== true) throw new AuthVerifyError("email is not verified");

  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new AuthVerifyError("token expired or exp missing");
  }
  if (exp <= now - skew) throw new AuthVerifyError("token expired");

  const nbf = payload["nbf"];
  if (nbf !== undefined) {
    if (typeof nbf !== "number" || !Number.isFinite(nbf)) {
      throw new AuthVerifyError("malformed nbf claim");
    }
    if (nbf > now + skew) throw new AuthVerifyError("token is not valid yet (nbf)");
  }

  const iat = payload["iat"];
  if (iat !== undefined) {
    if (typeof iat !== "number" || !Number.isFinite(iat)) {
      throw new AuthVerifyError("malformed iat claim");
    }
    if (iat > now + skew) throw new AuthVerifyError("token issued in the future (iat)");
  }

  if (payload["iss"] !== options.issuer) throw new AuthVerifyError("issuer mismatch");

  const expected = Array.isArray(options.audience) ? options.audience : [options.audience];
  const audience = payload["aud"];
  const presented = Array.isArray(audience) ? audience : [audience];
  if (!presented.some((a) => typeof a === "string" && expected.includes(a))) {
    throw new AuthVerifyError("audience mismatch");
  }

  const name = payload["name"];
  return makeIdentity(
    sub,
    email,
    typeof name === "string" && name.length > 0 ? name : null,
    exp,
  );
}

const KEY_BY_ALG: Record<string, { kty: string; crv?: string }> = {
  ES256: { kty: "EC", crv: "P-256" },
  RS256: { kty: "RSA" },
  PS256: { kty: "RSA" },
  EdDSA: { kty: "OKP", crv: "Ed25519" },
};

/**
 * Binds the token header to the JWKS entry before any crypto runs. Returns
 * the algorithm both agree on (or throws). Real Neon Auth JWKS entries omit
 * `use`/`key_ops`, so their absence is fine; when present they must not
 * contradict signing.
 */
function assertKeyBinding(
  header: Record<string, unknown>,
  jwk: Jwk,
): string {
  const alg = header["alg"];
  if (typeof alg !== "string" || !(alg in KEY_BY_ALG)) {
    throw new AuthVerifyError("unsupported token alg");
  }
  const kid = header["kid"];
  if (typeof kid !== "string" || kid.length === 0) {
    throw new AuthVerifyError("token header missing kid");
  }
  if (jwk.kid !== kid) throw new AuthVerifyError("JWKS key does not match the token's kid");
  if (jwk.d !== undefined) throw new AuthVerifyError("refusing private-key material");
  if (jwk.use !== undefined && jwk.use !== "sig") {
    throw new AuthVerifyError("JWKS key is not a signing key (use)");
  }
  if (jwk.key_ops !== undefined) {
    if (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify")) {
      throw new AuthVerifyError("JWKS key_ops does not allow verify");
    }
  }
  if (jwk.alg !== alg) {
    throw new AuthVerifyError("JWKS key alg does not match the token alg");
  }
  const expected = KEY_BY_ALG[alg]!;
  if (jwk.kty !== expected.kty) throw new AuthVerifyError("JWKS key type does not match the token alg");
  if (expected.crv !== undefined && jwk.crv !== expected.crv) {
    throw new AuthVerifyError("JWKS curve does not match the token alg");
  }
  return alg;
}

function verifySignature(
  signingInput: string,
  signature: Buffer,
  alg: string,
  jwk: Jwk,
): boolean {
  const data = Buffer.from(signingInput, "utf8");
  try {
    const keyObject = crypto.createPublicKey({
      key: jwk as unknown as crypto.JsonWebKey,
      format: "jwk",
    });
    switch (alg) {
      case "ES256":
        // JOSE fixed-width r||s only: node's DER default would also accept a
        // DER signature, which a real JWT never carries.
        return crypto.verify(
          "sha256",
          data,
          { key: keyObject, dsaEncoding: "ieee-p1363" },
          signature,
        );
      case "RS256":
      case "PS256":
        return crypto.verify(
          "sha256",
          data,
          {
            key: keyObject,
            padding:
              alg === "PS256"
                ? crypto.constants.RSA_PKCS1_PSS_PADDING
                : crypto.constants.RSA_PKCS1_PADDING,
            saltLength: alg === "PS256" ? 32 : undefined,
          },
          signature,
        );
      case "EdDSA":
        return crypto.verify(null, data, keyObject, signature);
      default:
        return false;
    }
  } catch {
    // Key/algorithm mismatch is a refusal, not a crash.
    return false;
  }
}

/** Extracts the raw key of the matching kid — tests hand it over directly. */
export function verifyWithJwk(
  token: string,
  jwk: Jwk,
  options: VerifyOptions,
): StaffIdentity {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  const alg = assertKeyBinding(header, jwk);
  if (alg === "ES256" && signature.length !== 64) {
    throw new AuthVerifyError("ES256 signatures must be 64-byte JOSE r||s, not DER");
  }
  if (!verifySignature(signingInput, signature, alg, jwk)) {
    throw new AuthVerifyError("signature verification failed");
  }
  return extractIdentity(payload, options);
}

export class JwksError extends AuthVerifyError {}

interface JwksCache {
  keys: Jwk[];
  fetchedAt: number;
}

const cache = new Map<string, JwksCache>();
const TTL_MS = 10 * 60 * 1000;

async function fetchJwks(client: JwksClient): Promise<Jwk[]> {
  const cached = cache.get(client.url);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.keys;
  const res = await (client.fetch ?? fetch)(client.url, {
    signal: AbortSignal.timeout(8000),
  });
  if (res.status !== 200) throw new JwksError(`JWKS endpoint answered ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new JwksError("JWKS body missing keys array");
  cache.set(client.url, { keys: body.keys, fetchedAt: Date.now() });
  return body.keys;
}

/**
 * Verifies a bearer JWT against the branch JWKS. `kid` selects the key;
 * unknown kids force one refresh before failing (key rotation).
 */
export async function verifyIdentityToken(
  token: string,
  client: JwksClient,
  options: VerifyOptions,
): Promise<StaffIdentity> {
  const keys = await fetchJwks(client);
  const kid = decodeJwt(token).header["kid"];
  if (typeof kid !== "string" || kid.length === 0) {
    throw new AuthVerifyError("token header missing kid");
  }
  const pick = (list: Jwk[]): Jwk | undefined => list.find((k) => k.kid === kid);
  let jwk = pick(keys);
  if (!jwk) {
    cache.delete(client.url); // key rotation: one refresh before refusing
    jwk = pick(await fetchJwks(client));
  }
  if (!jwk) throw new JwksError("no JWKS key matched the token's kid");
  return verifyWithJwk(token, jwk, options);
}

/**
 * Resolves the auth client from env. `NEON_AUTH_BASE_URL` doubles as the
 * issuer (and the default audience, which is Better Auth's convention);
 * `NEON_AUTH_ISSUER` / `NEON_AUTH_AUDIENCE` override either explicitly.
 */
export function loadAuthConfig(
  source: Record<string, string | undefined>,
): AuthClientConfig {
  const url = source["NEON_AUTH_JWKS_URL"];
  if (!url) throw new AuthConfigError("NEON_AUTH_JWKS_URL is required");
  try {
    new URL(url);
  } catch {
    throw new AuthConfigError("NEON_AUTH_JWKS_URL is not a valid URL");
  }
  // `||`, not `??`: CI maps every contract name into the job env, and a name the
  // GitHub Environment does not set resolves to the EMPTY STRING, not to
  // undefined. `??` therefore never fell back to NEON_AUTH_BASE_URL when a
  // workflow mapped `NEON_AUTH_ISSUER: ${{ vars.NEON_AUTH_ISSUER }}` and the
  // variable was absent — the oneOf group passed the file-based readiness check
  // (name absent) and failed the env-based one (name present, empty). The
  // contract's rule is presence = non-empty; this is that rule.
  const issuer =
    (source["NEON_AUTH_ISSUER"] ?? "").trim() ||
    (source["NEON_AUTH_BASE_URL"] ?? "").trim();
  if (!issuer) {
    throw new AuthConfigError(
      "NEON_AUTH_ISSUER or NEON_AUTH_BASE_URL is required to verify token issuer",
    );
  }
  return {
    url,
    issuer,
    audience: (source["NEON_AUTH_AUDIENCE"] ?? "").trim() || issuer,
  };
}
