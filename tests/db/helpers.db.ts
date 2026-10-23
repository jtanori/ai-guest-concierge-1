/**
 * S01 DB test harness.
 *
 * Tests run against a per-run scratch database: the helper creates (or
 * recreates) `scratch_<pid>`, applies all migrations, and hands out a client.
 * Unit tests must stay fast and DB-free (npm test), so this suite runs under
 * `npm run db:test`; CI starts a pgvector service container for it.
 */
import pg from "pg";
import { migrateDatabase } from "../../src/db/migrate.ts";

export const SCRATCH_DB = `scratch_${process.pid}`;

export function scratchUrl(dbName = SCRATCH_DB): string {
  // Accept TEST_DATABASE_URL (CI service or override) as an admin-level
  // connection whose server we can CREATE/DROP DATABASEs on.
  const base = process.env["TEST_DATABASE_URL"] ?? "postgres://concierge:concierge@localhost:54329/concierge_local";
  const parsed = new URL(base);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

export function scratchAdminUrl(): string {
  // Points at the "default" database on the same server (CREATE/DROP
  // DATABASE cannot run inside a transaction and must target a different db).
  const base = process.env["TEST_DATABASE_URL"] ?? "postgres://concierge:concierge@localhost:54329/concierge_local";
  return base;
}

export async function recreateScratch(): Promise<void> {
  const admin = new pg.Client({ connectionString: scratchAdminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
  await migrateDatabase(scratchUrl());
}

export async function dropScratch(): Promise<void> {
  const admin = new pg.Client({ connectionString: scratchAdminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

export function connectScratch(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: scratchUrl() });
  // Scratch lifecycle kills connections out from under suites (the next
  // file's beforeAll DROPs the db): the socket 'error' must never become an
  // unhandled event on the test process.
  client.on("error", () => undefined);
  return client.connect().then(() => client);
}

/* ---------- tenant query helpers for the RLS suite ---------- */

/** A brand-new tenant graph: org, property, channel connection, conversation. */
export interface TenantFixture {
  orgId: string;
  propertyId: string;
  channelId: string;
  conversationId: string;
}

export async function seedTenant(client: pg.Client, name: string): Promise<TenantFixture> {
  const org = await client.query<{ org_id: string }>(
    "INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING org_id",
    [`org_${name}`],
  );
  const orgId = org.rows[0]!.org_id;

  const property = await client.query<{ property_id: string }>(
    "INSERT INTO properties (org_id, name, slug) VALUES ($1, $2, $2) RETURNING property_id",
    [orgId, name],
  );
  const propertyId = property.rows[0]!.property_id;

  const channel = await client.query<{ channel_connection_id: string }>(
    "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web') RETURNING channel_connection_id",
    [orgId, propertyId],
  );
  const channelId = channel.rows[0]!.channel_connection_id;

  const conversation = await client.query<{ conversation_id: string }>(
    "INSERT INTO conversations (org_id, property_id, connection_id) VALUES ($1, $2, $3) RETURNING conversation_id",
    [orgId, propertyId, channelId],
  );
  const conversationId = conversation.rows[0]!.conversation_id;

  return { orgId, propertyId, channelId, conversationId };
}

/**
 * Non-superuser session emulating the deployed app: docker/CI service
 * superusers bypass RLS entirely, so suite queries drop into `concierge_app`
 * (created by 0002) — the role RLS actually constrains.
 */
export async function asTenantApp(client: pg.Client): Promise<void> {
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE concierge_app");
}
