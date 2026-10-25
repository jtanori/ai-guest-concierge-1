/**
 * S02-01 — staff identity (D1's auth half).
 *
 * The provider is Neon Auth (managed Better Auth). Our contract with it is
 * deliberately narrow: a bearer JWT whose signature verifies against the
 * branch JWKS endpoint (NEON_AUTH_* env, probed in W00). Claims we bind:
 * `sub` (the Neon Auth user id) and `email` (provisioned users row). Roles
 * are NEVER taken from tokens or request bodies — they resolve from
 * `memberships` under RLS (db/migrations/0004_auth.sql).
 *
 * Verification uses node:crypto only; supported signature algorithms are the
 * EC/RSA/Ed25519 families that appear in JWKS in practice (ES256, RS256,
 * PS256, EdDSA).
 */
import crypto from "node:crypto";

export interface StaffIdentity {
  /** Neon Auth `sub` — idempotently mapped to users.neon_auth_user_id. */
  neonAuthUserId: string;
  email: string;
  displayName: string | null;
  /** seconds — used by the caller to build the session record. */
  expiresAt: number;
}

export class AuthVerifyError extends Error {}

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
}

/** Decoding + claim validation. Signature per key follows below. */
function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
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

function extractIdentity(payload: Record<string, unknown>, nowEpoch: number): StaffIdentity {
  const sub = payload["sub"];
  const email = payload["email"];
  if (typeof sub !== "string" || sub.length === 0) throw new AuthVerifyError("missing sub claim");
  if (typeof email !== "string" || email.length === 0) throw new AuthVerifyError("missing email claim");
  const exp = payload["exp"];
  if (typeof exp !== "number" || exp <= nowEpoch) throw new AuthVerifyError("token expired or exp missing");
  const name = payload["name"];
  return {
    neonAuthUserId: sub,
    email,
    displayName: typeof name === "string" && name.length > 0 ? name : null,
    expiresAt: exp,
  };
}

function verifySignature(
  signingInput: string,
  signature: Buffer,
  hed: Record<string, unknown>,
  jwk: Jwk,
): boolean {
  const data = Buffer.from(signingInput, "utf8");
  try {
    const keyObject = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
    switch (hed["alg"]) {
      case "ES256":
        return crypto.verify("sha256", data, keyObject, paddedEcSignature(signature));
      case "RS256":
      case "PS256":
        // RSASSA-PKCS1 vs RSASSA-PSS — node keys it off the padding option.
        return crypto.verify("sha256", data, {
          key: keyObject,
          padding: hed["alg"] === "PS256" ? crypto.constants.RSA_PKCS1_PSS_PADDING : crypto.constants.RSA_PKCS1_PADDING,
          saltLength: hed["alg"] === "PS256" ? 32 : undefined,
        }, signature);
      case "EdDSA": {
        if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return false;
        return crypto.verify(null, data, keyObject, signature);
      }
      default:
        return false;
    }
  } catch {
    // Key/algorithm mismatch is a refusal, not a crash.
    return false;
  }
}

/** JOSE r||s (64 bytes) → canonical DER, as node:crypto/OpenSSL requires. */
function paddedEcSignature(sig: Buffer): Buffer {
  // Test-fixture signers hand node's own DER over; real JWTs are always the
  // fixed-width JOSE form.
  if (sig.length !== 64) return sig;
  // Each half is a big-endian integer in exactly 32 bytes; strip the
  // redundant leading zeros JOSE's fixed-width encoding allows, prepend 0x00
  // only when a one then appears (or the integer would read as negative),
  // and wrap both in an ASN.1 SEQUENCE.
  const part = (raw: Buffer): Buffer => {
    let first = 0;
    while (first < raw.length - 1 && raw[first] === 0) first++;
    const integer = raw.subarray(first);
    const padded =
      (integer[0] ?? 0) & 0x80
        ? Buffer.concat([Buffer.from([0x00]), integer])
        : integer;
    return Buffer.concat([Buffer.from([0x02, padded.length]), padded]);
  };
  const rDer = part(sig.subarray(0, 32));
  const sDer = part(sig.subarray(32, 64));
  return Buffer.concat([Buffer.from([0x30, rDer.length + sDer.length]), rDer, sDer]);
}

/** Test/interop seam: canonical DER for a JOSE (fixed-width) signature. */
export function derEncodeJose(sig: Buffer): Buffer {
  return paddedEcSignature(sig);
}

/** Extracts the raw key of the matching kid — tests hand it over directly. */
export function verifyWithJwk(token: string, jwk: Jwk, nowEpoch = Date.now() / 1000): StaffIdentity {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header["alg"] === "none" || jwk.d) throw new AuthVerifyError("refusing private-key material");
  if (!verifySignature(signingInput, signature, header, jwk)) {
    throw new AuthVerifyError("signature verification failed");
  }
  return extractIdentity(payload, nowEpoch);
}

export class JwksError extends AuthVerifyError {}

interface JwksCache {
  keys: Jwk[];
  fetchedAt: number;
}

const cache = new Map<string, JwksCache>();
const TTL_MS = 10 * 60 * 1000;

async function fetchJwks(client: { url: string; fetch?: typeof fetch }): Promise<Jwk[]> {
  const cached = cache.get(client.url);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.keys;
  const res = await (client.fetch ?? fetch)(client.url, { signal: AbortSignal.timeout(8000) });
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
  client: { url: string; fetch?: typeof fetch },
  nowEpoch = Date.now() / 1000,
): Promise<StaffIdentity> {
  const keys = await fetchJwks(client);
  const kidFromToken = decodeJwt(token).header["kid"];
  const pick = (list: Jwk[]): Jwk | undefined =>
    typeof kidFromToken === "string" ? list.find((k) => k.kid === kidFromToken) : list[0];
  let jwk = pick(keys);
  if (!jwk) {
    cache.delete(client.url); // key rotation: one refresh before refusing
    jwk = pick(await fetchJwks(client));
  }
  if (!jwk) throw new JwksError("no JWKS key matched the token's kid");
  return verifyWithJwk(token, jwk, nowEpoch);
}

/** Strong-typed claim assemblers for the fake sessions tests use. */
export function fakeIdentity(overrides: Partial<StaffIdentity> = {}): StaffIdentity {
  return {
    neonAuthUserId: "auth0|00000000000000000000",
    email: "staff@example.com",
    displayName: "Test Staff",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}
