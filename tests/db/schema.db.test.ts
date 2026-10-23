/**
 * S01-01 — schema tests: migrations run clean from an EMPTY database, land
 * exactly the 25 planned tables, carry D2/D3 retrieval columns, and keep the
 * ERD from drifting (db/erd.mmd must match reality, not just intention).
 *
 * Persisted surface for the runbook:
 *   npm run db:migrate   → scripts/migrate.ts passes along migrateDatabase
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { dropScratch, recreateScratch, scratchUrl } from "./helpers.db.ts";

const ERD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "db",
  "erd.mmd",
);

/** Plan of record §2 "Data model" — exactly these 25 tables, in this order. */
export const PLAN_TABLES = [
  "organizations", "properties", "users", "memberships", "roles",
  "channel_connections", "channel_identities",
  "conversations", "messages", "message_delivery_events",
  "service_requests", "assignments", "internal_notes",
  "knowledge_sources", "knowledge_articles", "article_versions",
  "property_facts", "ai_runs", "citations", "handoff_reasons",
  "knowledge_gaps", "events", "rollups", "audit_log", "outbox",
] as const;

async function publicTables(client: pg.Client): Promise<Array<string>> {
  const res = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return res.rows.map((r) => r.table_name);
}

describe("schema (db)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    await recreateScratch();
    client = new pg.Client({ connectionString: scratchUrl() });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("runs clean from an EMPTY database (applies every file, in order)", async () => {
    // recreateScratch dropped + created the database and already applied
    // everything: the clean-run proves itself by having all migrations
    // recorded. Idempotency: a second pass is a no-op.
    const second = await migrateDatabase(scratchUrl());
    expect(second).toBe(0);
    const files = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    expect(files.rows.map((r) => r.filename).sort()).toEqual([
      "0001_init.sql", "0002_rls.sql", "0003_immutability.sql",
    ]);
  });

  it("has exactly the 25 tables the plan of record names", async () => {
    const tables = (await publicTables(client)).filter(
      (t) => t !== "schema_migrations",
    );
    expect(new Set(tables)).toEqual(new Set(PLAN_TABLES));
    expect(tables).toHaveLength(25);
  });

  it("fails loudly when an applied migration's file content drifts (checksum guard)", async () => {
    const stored = await client.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE filename = '0001_init.sql'",
    );
    const original = stored.rows[0]!.checksum;
    try {
      await client.query(
        "UPDATE schema_migrations SET checksum = 'tampered' WHERE filename = '0001_init.sql'",
      );
      // The stored checksum no longer describes what was applied; the runner
      // must refuse to continue rather than silently reuse the old schema.
      await expect(migrateDatabase(scratchUrl())).rejects.toThrow(/checksum mismatch/);
    } finally {
      await client.query(
        "UPDATE schema_migrations SET checksum = $1 WHERE filename = '0001_init.sql'",
        [original],
      );
    }
  });

  it("keeps the committed ERD in sync with reality (no drift)", async () => {
    const erd = await readFile(ERD_PATH, "utf8");
    const entityNames = [...erd.matchAll(/^\s{4}([a-z_]+) \{$/gm)].map((m) => m[1]);
    const tables = (await publicTables(client)).filter(
      (t) => t !== "schema_migrations",
    );
    expect(new Set(entityNames)).toEqual(new Set(tables));
  });

  it("pinpoints D2/D3 retrieval machinery on the right tables", async () => {
    const cols = await client.query<{ table_name: string; column_name: string; udt_name: string }>(
      "SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE column_name IN ('embedding', 'tsv') AND table_schema = 'public'",
    );
    const embeddings = cols.rows.filter((r) => r.column_name === "embedding");
    expect(embeddings).toHaveLength(2);
    embeddings.forEach((r) => {
      expect(r.table_name).toBeOneOf(["article_versions", "property_facts"]);
      expect(r.udt_name).toBe("vector");
    });
    const tsvs = cols.rows.filter((r) => r.column_name === "tsv");
    expect(tsvs.map((r) => r.table_name).sort()).toEqual(["article_versions", "property_facts"]);

    const exts = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')",
    );
    expect(new Set(exts.rows.map((r) => r.extname))).toEqual(new Set(["vector", "pg_trgm"]));
  });

  it("cites article_version_id, not article_id (D5)", async () => {
    const fk = await client.query<{ foreign_table: string; foreign_column: string }>(
      `SELECT DISTINCT ccu.table_name AS foreign_table, kcu.column_name AS foreign_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'citations'`,
    );
    // the FK is tenant-composite: (org_id, property_id, article_version_id) —
    // so a citation can never point at another tenant's version either.
    const versionFkCols = fk.rows
      .filter((r) => r.foreign_table === "article_versions")
      .map((r) => r.foreign_column)
      .sort();
    expect(versionFkCols).toEqual(["article_version_id", "org_id", "property_id"]);
    const articleFk = fk.rows.find((r) => r.foreign_table === "knowledge_articles");
    expect(articleFk).toBeUndefined();
  });

  it("constrains events to the 18-name taxonomy verbatim (Appendix C v1.2.1)", async () => {
    const { ORG_ID, PROPERTY_ID, CONVERSATION_ID } = await seedControlRow(client);
    // Sanity first: an allowed event type inserts cleanly.
    await client.query(
      `INSERT INTO events (org_id, property_id, conversation_id, channel, event_type)
       VALUES ($1, $2, $3, 'web', 'conversation_started')`,
      [ORG_ID, PROPERTY_ID, CONVERSATION_ID],
    );
    // The 19th (invented) name from the plan's ruling note is rejected.
    await expect(
      client.query<{ event_type: string }>(
        `INSERT INTO events (org_id, property_id, conversation_id, channel, event_type)
         VALUES ($1, $2, $3, 'web', 'answer_overridden') RETURNING event_type`,
        [ORG_ID, PROPERTY_ID, CONVERSATION_ID],
      ),
    ).rejects.toThrow(/check_?constraint|violates check/i);
  });

  it("protects D5 history: article_versions rows are append-only", async () => {
    const { ORG_ID, PROPERTY_ID } = await seedControlRow(client);
    const article = await client.query<{ article_id: string }>(
      `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title)
       VALUES ($1, $2, 'property', 'pool.hours', 'Pool schedule') RETURNING article_id`,
      [ORG_ID, PROPERTY_ID],
    );
    const articleId = article.rows[0]!.article_id;
    const version = await client.query<{ article_version_id: string }>(
      `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
       VALUES ($1, $2, $3, 1, 'Pool closes at 21:00.') RETURNING article_version_id`,
      [ORG_ID, PROPERTY_ID, articleId],
    );
    const versionId = version.rows[0]!.article_version_id;

    await expect(
      client.query("UPDATE article_versions SET body = 'tampered' WHERE article_version_id = $1", [versionId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query("DELETE FROM article_versions WHERE article_version_id = $1", [versionId]),
    ).rejects.toThrow(/append-only/);
  });

  it("keeps exactly one current article version and forbids history rewrites", async () => {
    const { ORG_ID, PROPERTY_ID } = await seedControlRow(client);
    const article = await client.query<{ article_id: string }>(
      `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title)
       VALUES ($1, $2, 'property', 'wifi.access', 'Wi-Fi access') RETURNING article_id`,
      [ORG_ID, PROPERTY_ID],
    );
    const articleId = article.rows[0]!.article_id;
    const v1 = await client.query<{ article_version_id: string }>(
      `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
       VALUES ($1, $2, $3, 1, 'Network: GuestWiFi, password on the room card.') RETURNING article_version_id`,
      [ORG_ID, PROPERTY_ID, articleId],
    );
    const v1Id = v1.rows[0]!.article_version_id;
    let state = await client.query<{ version_no: number; is_current: boolean }>(
      "SELECT version_no, is_current FROM article_versions WHERE article_id = $1 ORDER BY version_no",
      [articleId],
    );
    expect(state.rows[0]!.is_current).toBe(true);

    // A newer version automatically becomes THE current one.
    await client.query(
      `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
       VALUES ($1, $2, $3, 2, 'Network updated: GuestPlus.')`,
      [ORG_ID, PROPERTY_ID, articleId],
    );
    state = await client.query<{ version_no: number; is_current: boolean }>(
      "SELECT version_no, is_current FROM article_versions WHERE article_id = $1 ORDER BY version_no",
      [articleId],
    );
    expect(state.rows).toHaveLength(2);
    expect(state.rows.map((r) => r.is_current)).toEqual([false, true]);

    // A demoted version cannot be re-raised: is_current only moves forward.
    await expect(
      client.query("UPDATE article_versions SET is_current = true WHERE article_version_id = $1", [v1Id]),
    ).rejects.toThrow(/append-only/);
    // And a body rewrite stays forbidden on the current version too.
    await expect(
      client.query("UPDATE article_versions SET body = 'edited after the fact' WHERE article_id = $1 AND version_no = 2", [articleId]),
    ).rejects.toThrow(/append-only/);
  });

  it("permits embedding backfill on the current version (and nothing else)", async () => {
    const { ORG_ID, PROPERTY_ID } = await seedControlRow(client);
    const article = await client.query<{ article_id: string }>(
      `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title)
       VALUES ($1, $2, 'property', 'pool.hours', 'Pool schedule') RETURNING article_id`,
      [ORG_ID, PROPERTY_ID],
    );
    const articleId = article.rows[0]!.article_id;
    const v1 = await client.query<{ article_version_id: string }>(
      `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
       VALUES ($1, $2, $3, 1, 'Pool closes at 20:00.') RETURNING article_version_id`,
      [ORG_ID, PROPERTY_ID, articleId],
    );
    const v1Id = v1.rows[0]!.article_version_id;

    // The asynchronous backfill: populate the embedding of a CURRENT row.
    const vector = `[${Array.from({ length: 1536 }, () => 0).join(",")}]`;
    await client.query(
      "UPDATE article_versions SET embedding = $2 WHERE article_version_id = $1",
      [v1Id, vector],
    );
    const reread = await client.query<{ embedding: string }>(
      "SELECT embedding::text AS embedding FROM article_versions WHERE article_version_id = $1",
      [v1Id],
    );
    expect(reread.rows[0]!.embedding).toBe(vector);

    // While it is current, nothing else may move...
    await expect(
      client.query("UPDATE article_versions SET body = 'rewrite' WHERE article_version_id = $1", [v1Id]),
    ).rejects.toThrow(/append-only/);
    // ...and after demotion, a re-promotion is still impossible.
    await client.query(
      `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
       VALUES ($1, $2, $3, 2, 'The pool schedule changed for fall.')`,
      [ORG_ID, PROPERTY_ID, articleId],
    );
    await expect(
      client.query("UPDATE article_versions SET is_current = true WHERE article_version_id = $1", [v1Id]),
    ).rejects.toThrow(/append-only/);
  });

  it("protects D10 evidence: events and audit_log are append-only", async () => {
    const { ORG_ID, PROPERTY_ID, CONVERSATION_ID } = await seedControlRow(client);
    const ev = await client.query<{ event_id: string }>(
      `INSERT INTO events (org_id, property_id, conversation_id, channel, event_type)
       VALUES ($1, $2, $3, 'web', 'conversation_started') RETURNING event_id`,
      [ORG_ID, PROPERTY_ID, CONVERSATION_ID],
    );
    const eventId = ev.rows[0]!.event_id;
    await expect(
      client.query("UPDATE events SET payload = '{\"x\":1}' WHERE event_id = $1", [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query("DELETE FROM events WHERE event_id = $1", [eventId]),
    ).rejects.toThrow(/append-only/);

    const audit = await client.query<{ audit_id: string }>(
      `INSERT INTO audit_log (org_id, property_id, action, entity_type, entity_id)
       VALUES ($1, $2, 'seed_probe', 'probe', 'n/a') RETURNING audit_id`,
      [ORG_ID, PROPERTY_ID],
    );
    const auditId = audit.rows[0]!.audit_id;
    await expect(
      client.query("UPDATE audit_log SET detail = '{}' WHERE audit_id = $1", [auditId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query("DELETE FROM audit_log WHERE audit_id = $1", [auditId]),
    ).rejects.toThrow(/append-only/);
  });
});

async function seedControlRow(client: pg.Client): Promise<{
  ORG_ID: string; PROPERTY_ID: string; CHANNEL_ID: string; CONVERSATION_ID: string;
}> {
  // A dedicated 4-row fixture for trigger tests; sub-tx via savepoint so an
  // intentionally rejected insert never poisons the session.
  const prefix = `ctl_${Math.random().toString(16).slice(2, 10)}`;
  const org = await client.query<{ org_id: string }>(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING org_id",
    [prefix, prefix],
  );
  const orgId = org.rows[0]!.org_id;
  const prop = await client.query<{ property_id: string }>(
    "INSERT INTO properties (org_id, name, slug) VALUES ($1, $2, $2) RETURNING property_id",
    [orgId, prefix],
  );
  const propertyId = prop.rows[0]!.property_id;
  const channel = await client.query<{ channel_connection_id: string }>(
    "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web') RETURNING channel_connection_id",
    [orgId, propertyId],
  );
  const channelId = channel.rows[0]!.channel_connection_id;
  const conv = await client.query<{ conversation_id: string }>(
    "INSERT INTO conversations (org_id, property_id, connection_id) VALUES ($1, $2, $3) RETURNING conversation_id",
    [orgId, propertyId, channelId],
  );
  return {
    ORG_ID: orgId, PROPERTY_ID: propertyId, CHANNEL_ID: channelId, CONVERSATION_ID: conv.rows[0]!.conversation_id,
  };
}
