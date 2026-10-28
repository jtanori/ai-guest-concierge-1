/**
 * Neon Postgres wiring (D2/D3 runtime choice).
 *
 * Driver: node-postgres (`pg`) — per the Neon skill guidance, the pooled
 * DATABASE_URL is preferred for application traffic, and `pg` is the
 * recommended driver for long-running Node runtimes (Vercel Fluid compute
 * and Neon Functions both advise it). The pooled URL comes from
 * `.env.local` (DATABASE_URL); migrations will later use the direct
 * UNPOOLED URL with a dedicated connection (S01).
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../config/env.ts";

export interface PostgresStatus {
  serverVersion: string;
  currentDatabase: string;
  availableExtensions: Array<string>;
  /**
   * W00-13 — a stable, non-reversible identity for this Postgres *cluster*.
   *
   * The AC's question is "are staging and prod different databases?", and the
   * obvious way to answer it — compare `current_database()` — is wrong on the
   * platform this product actually deploys to: Neon names every branch's database
   * `neondb`, so two genuinely separate clusters report the same name and the check
   * would fail on a correct deployment. It also cannot distinguish two databases on
   * the same cluster, which is the other half of the question.
   *
   * `system_identifier` from the control file is unique per cluster and needs no
   * privilege the app role lacks. It is hashed rather than published: the raw value
   * identifies the installation, and this route is unauthenticated.
   *
   * `null` when the probe could not read it — the smoke check then reports SKIP
   * rather than inventing a verdict.
   */
  clusterFingerprint: string | null;
}

let pool: pg.Pool | null = null;

/**
 * Runtime connections must run as the non-superuser `concierge_app` role:
 * the deployed Neon login role owns the tables, and PostgreSQL lets owners
 * bypass RLS unless FORCE is set — and even then the login role's membership
 * in definer roles would be an escalation path. The startup `role` parameter
 * applies to every new session in the pool, so no query can forget it
 * (review round 2, 4369257062).
 */
export function appPoolConfig(connectionString: string): pg.PoolConfig {
  return {
    connectionString,
    // Application traffic keeps a tiny pool; workers/seeds make their own.
    max: 3,
    idleTimeoutMillis: 30_000,
    options: "-c role=concierge_app",
  };
}

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = loadConfig(process.env);
    pool = new pg.Pool(appPoolConfig(cfg.databaseUrl));
    pool.on("error", (err) => {
      // A dropped idle connection must never crash the process.
      console.error(JSON.stringify({ event: "pg_pool_error", err: err.message }));
    });
  }
  return pool;
}

export async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Read-only probe used by /healthz/postgres and the smoke script. */
export async function postgresStatus(): Promise<PostgresStatus> {
  const rows = await query<{ version: string; db: string }>(
    "SELECT version() AS version, current_database() AS db",
  );
  const ext = await query<{ name: string }>(
    "SELECT name FROM pg_available_extensions WHERE name IN ('vector', 'pg_trgm') ORDER BY name",
  );
  return {
    serverVersion: rows[0]?.version ?? "unknown",
    currentDatabase: rows[0]?.db ?? "unknown",
    availableExtensions: ext.map((e) => e.name),
    clusterFingerprint: await clusterFingerprint(),
  };
}

/**
 * `system_identifier` is a bigint; node-postgres hands back a string, which is
 * exactly what we want to hash. Any failure (an older server without
 * `pg_control_system()`, a restricted role) yields `null`: a health route must stay
 * up, and a missing fingerprint is reported as unknown, never as "different".
 */
async function clusterFingerprint(): Promise<string | null> {
  try {
    const rows = await query<{ system_identifier: string }>(
      "SELECT system_identifier::text FROM pg_control_system()",
    );
    const identifier = rows[0]?.system_identifier;
    if (identifier === undefined || identifier === "") return null;
    return createHash("sha256").update(identifier).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}
