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
import pg from "pg";
import { loadConfig } from "../config/env.ts";

export interface PostgresStatus {
  serverVersion: string;
  currentDatabase: string;
  availableExtensions: Array<string>;
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
  };
}
