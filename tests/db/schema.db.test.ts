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
import { withTenant } from "../../src/db/tenant.ts";

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
  // S04-01 (0010): the plan's 25 plus the review queue's two tenant tables.
  "article_reviews", "fact_resolutions",
  // S04-02 (0011): the retrieval unit.
  "article_chunks",
  // S07-04 (0019): the flood counters and the money counters. Both are tenant
  // tables with RLS rather than a Redis-shaped side channel, because a limit
  // that a replica can reset is not a limit.
  "rate_limits", "spend_counters",
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
      "0001_init.sql",
      "0002_rls.sql",
      "0003_immutability.sql",
      "0004_auth.sql",
      "0005_auth_hardening.sql",
      "0006_property_settings.sql",
      "0007_audit_privileges.sql",
      "0008_article_versions_body_nullable.sql",
      "0009_property_facts.sql",
      "0010_review_queue.sql",
      "0011_article_chunks.sql",
      "0012_retrieval_indexes.sql",
      "0013_retrieval_weights.sql",
      "0014_ai_runs_indexes.sql",
      "0015_guest_chat.sql",
      "0016_conversation_state.sql",
      "0017_handoff_from_resolved.sql",
      "0018_request_capture.sql",
      "0019_abuse_and_spend.sql",
      "0020_embed_settings.sql",
      "0021_inbox_indexes.sql",
      "0022_citation_quotes.sql",
    ]);
  });

  it("has exactly the plan's 25 tables plus the items that added tables", async () => {
    const tables = (await publicTables(client)).filter(
      (t) => t !== "schema_migrations",
    );
    expect(new Set(tables)).toEqual(new Set(PLAN_TABLES));
    expect(tables).toHaveLength(30);
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
    // S04-02 added the retrieval unit: chunks carry both a vector and a tsv.
    expect(embeddings).toHaveLength(3);
    embeddings.forEach((r) => {
      expect(r.table_name).toBeOneOf(["article_versions", "property_facts", "article_chunks"]);
      expect(r.udt_name).toBe("vector");
    });
    const tsvs = cols.rows.filter((r) => r.column_name === "tsv");
    expect(tsvs.map((r) => r.table_name).sort()).toEqual([
      "article_chunks",
      "article_versions",
      "property_facts",
    ]);

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

  it("keeps exactly one current article version via atomic promotion", async () => {
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
    // New versions insert RETIRED; the embed-first flow promotes explicitly —
    // and promotion REFUSES to publish an unindexed version.
    const state = await client.query<{ is_current: boolean }>(
      "SELECT is_current FROM article_versions WHERE article_version_id = $1",
      [v1Id],
    );
    expect(state.rows[0]!.is_current).toBe(false);
    await expect(
      withTenant(client, { orgId: ORG_ID, propertyId: PROPERTY_ID }, (tx) => tx.query("SELECT promote_article_version($1)", [v1Id])),
    ).rejects.toThrow(/embedding/);

    // Embed first — then one atomic step demotes nothing and raises v1.
    await client.query(
      "UPDATE article_versions SET embedding = $2 WHERE article_version_id = $1",
      [v1Id, `[${Array.from({ length: 1536 }, () => 0).join(",")}]`],
    );
    await withTenant(client, { orgId: ORG_ID, propertyId: PROPERTY_ID }, (tx) => tx.query("SELECT promote_article_version($1)", [v1Id]));
    let current = await client.query<{ version_no: number }>(
      "SELECT version_no FROM article_versions WHERE article_id = $1 AND is_current",
      [articleId],
    );
    expect(current.rows[0]!.version_no).toBe(1);

    // A replacement that is NOT yet ready (no embedding, no promotion) must
    // not displace the live version: v2 stays retired while v1 serves.
    const v2 = await client.query<{ article_version_id: string }>(
      `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
       VALUES ($1, $2, $3, 2, 'Network updated: GuestPlus.') RETURNING article_version_id`,
      [ORG_ID, PROPERTY_ID, articleId],
    );
    const v2Id = v2.rows[0]!.article_version_id;
    current = await client.query<{ version_no: number }>(
      "SELECT version_no FROM article_versions WHERE article_id = $1 AND is_current",
      [articleId],
    );
    expect(current.rows).toHaveLength(1);
    expect(current.rows[0]!.version_no).toBe(1);

    // Embed first — then one atomic statement demotes v1 and raises v2.
    await client.query(
      "UPDATE article_versions SET embedding = $2 WHERE article_version_id = $1",
      [v2Id, `[${Array.from({ length: 1536 }, () => 0).join(",")}]`],
    );
    await withTenant(client, { orgId: ORG_ID, propertyId: PROPERTY_ID }, (tx) => tx.query("SELECT promote_article_version($1)", [v2Id]));
    current = await client.query<{ version_no: number }>(
      "SELECT version_no FROM article_versions WHERE article_id = $1 AND is_current",
      [articleId],
    );
    expect(current.rows).toHaveLength(1);
    expect(current.rows[0]!.version_no).toBe(2);

    // A retired version can never be re-raised by a plain UPDATE — the
    // trusted context is a ROLE membership, not a settable GUC.
    await expect(
      client.query("UPDATE article_versions SET is_current = true WHERE article_version_id = $1", [v1Id]),
    ).rejects.toThrow(/moves only inside promote_article_version/);
    // ...nor by the promotion function itself: v1 carries promoted_at, and a
    // retired target is refused (one-way history).
    await expect(
      withTenant(client, { orgId: ORG_ID, propertyId: PROPERTY_ID }, (tx) => tx.query("SELECT promote_article_version($1)", [v1Id])),
    ).rejects.toThrow(/retired history/);
    // The historical bypass attempt (set the no-longer-used GUC) changes
    // nothing.
    await client.query("SELECT set_config('app.article_version_promotion', 'atomic', false)");
    await expect(
      client.query("UPDATE article_versions SET is_current = true WHERE article_version_id = $1", [v1Id]),
    ).rejects.toThrow(/promote_article_version/);
    // And a body rewrite stays forbidden on any version.
    await expect(
      client.query("UPDATE article_versions SET body = 'edited after the fact' WHERE article_version_id = $1", [v2Id]),
    ).rejects.toThrow(/append-only/);
  });

  it("exposes the promotion only to the owner and the app role (public EXECUTE revoked)", async () => {
    const pub = await client.query<{ ok: boolean }>(
      "SELECT has_function_privilege('public', 'promote_article_version(uuid)', 'EXECUTE') AS ok",
    );
    expect(pub.rows[0]!.ok).toBe(false);
    const app = await client.query<{ ok: boolean }>(
      "SELECT has_function_privilege('concierge_app', 'promote_article_version(uuid)', 'EXECUTE') AS ok",
    );
    expect(app.rows[0]!.ok).toBe(true);
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

    const vector = `[${Array.from({ length: 1536 }, () => 0).join(",")}]`;
    // The backfill may come before OR after a legitimate promotion — only
    // the update of an embedding must never hit the wall.
    await client.query(
      "UPDATE article_versions SET embedding = $2 WHERE article_version_id = $1",
      [v1Id, vector],
    );
    await withTenant(client, { orgId: ORG_ID, propertyId: PROPERTY_ID }, (tx) => tx.query("SELECT promote_article_version($1)", [v1Id]));
    const reread = await client.query<{ embedding: string }>(
      "SELECT embedding::text AS embedding FROM article_versions WHERE article_version_id = $1",
      [v1Id],
    );
    expect(reread.rows[0]!.embedding).toBe(vector);

    // While it is current, nothing else may move...
    await expect(
      client.query("UPDATE article_versions SET body = 'rewrite' WHERE article_version_id = $1", [v1Id]),
    ).rejects.toThrow(/append-only/);
    // ...and an attempt to declare a NEW version current via INSERT is
    // impossible as well: rows are born retired.
    await expect(
      client.query(
        `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body, is_current)
         VALUES ($1, $2, $3, 2, 'The pool schedule changed for fall.', true)`,
        [ORG_ID, PROPERTY_ID, articleId],
      ),
    ).rejects.toThrow(/born retired|insert retired/);
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
