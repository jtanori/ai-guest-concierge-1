/**
 * Neon Auth wiring — Managed Better Auth (W00 scope: connectivity probe only).
 *
 * Auth state (users, sessions) lives in the `neon_auth` schema on the same
 * branch's Postgres and branches with it. The client API (`@neondatabase/auth`,
 * Better Auth method set) is wired in S02-01 when real login exists; this
 * module verifies the two injected endpoints respond and that the backing
 * schema is actually present.
 */
export interface AuthStatus {
  baseReachable: boolean;
  baseUrlStatus?: number;
  jwksKeys: number;
}

export class AuthEnvError extends Error {}

export async function authStatus(
  source: Record<string, string | undefined> = process.env,
): Promise<AuthStatus> {
  // The contract's auth-issuer group is oneOf: NEON_AUTH_ISSUER or
  // NEON_AUTH_BASE_URL satisfies token verification (loadAuthConfig). Requiring
  // BASE_URL here made a contract-valid ISSUER-only host pass readiness and then
  // throw on /healthz/auth — two gates, one rule, applied differently. The probe
  // targets whichever member the host actually has (both are base URLs).
  const baseUrl = source["NEON_AUTH_BASE_URL"] ?? source["NEON_AUTH_ISSUER"];
  const jwksUrl = source["NEON_AUTH_JWKS_URL"];
  if (!baseUrl) throw new AuthEnvError("missing NEON_AUTH_ISSUER or NEON_AUTH_BASE_URL");
  if (!jwksUrl) throw new AuthEnvError("missing NEON_AUTH_JWKS_URL");

  const [baseRes, jwksRes] = await Promise.all([
    fetch(baseUrl, { signal: AbortSignal.timeout(8000) }),
    fetch(jwksUrl, { signal: AbortSignal.timeout(8000) }),
  ]);
  const jwks = (await jwksRes.json()) as { keys?: unknown[] };
  return {
    baseReachable: baseRes.status < 500,
    baseUrlStatus: baseRes.status,
    jwksKeys: Array.isArray(jwks.keys) ? jwks.keys.length : 0,
  };
}

/** Is the managed Better Auth schema really on this branch? */
export async function neonAuthSchemaPresent(): Promise<boolean> {
  const { query } = await import("./postgres.ts");
  const rows = await query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'neon_auth') AS present",
  );
  return rows[0]?.present === true;
}
