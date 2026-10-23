/**
 * S01-02/S01-03 — RLS + cross-tenant isolation suite.
 *
 * Docker/CI service database roles are superusers, which bypass RLS entirely,
 * so tenant-visibility queries run via `SET LOCAL ROLE concierge_app` (the
 * non-superuser role created by 0002) - the closest analogue to the deployed
 * app on Neon, where the owner role is not a superuser and FORCE RLS applies.
 *
 * S01-02 AC: a query WITHOUT tenant context returns zero rows - asserted on
 * every tenant table, not just one.
 * S01-03 AC: the suite enumerates every tenant table, asserts zero foreign
 * rows, and runs in CI - wired via npm script `db:test`, whose CI job fails
 * the build on any leak.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropScratch, recreateScratch, scratchUrl } from "./helpers.db.ts";

/** The RLS policy name that marks a table as tenant-scoped (0002). */
const TENANT_POLICY = "tenant";

/** The 21 tenant tables: the plan's 25 minus organizations/users/roles/memberships. */
const EXPECTED_TENANT_TABLES = [
  "properties",
  "channel_connections", "channel_identities",
  "conversations", "messages", "message_delivery_events",
  "service_requests", "assignments", "internal_notes",
  "knowledge_sources", "knowledge_articles", "article_versions", "property_facts",
  "ai_runs", "citations", "handoff_reasons", "knowledge_gaps",
  "events", "rollups", "audit_log", "outbox",
];
/** The other four carry no `tenant` policy in S01 (role-scoped later, S02). */
const EXPECTED_GLOBAL_TABLES = ["organizations", "users", "roles", "memberships"];

describe("row-level security (db)", () => {
  // owner: superuser session, used ONLY for seeding and ground-truth counts.
  let owner: pg.Client;
  // swept session - dropped into concierge_app by asTenantApp below.
  let client: pg.Client;
  let ORG_A = "", PROP_A = "", CONV_A = "";
  let ORG_B = "", PROP_B = "", CONV_B = "";

  beforeAll(async () => {
    await recreateScratch();
    owner = new pg.Client({ connectionString: scratchUrl() });
    await owner.connect();
    client = new pg.Client({ connectionString: scratchUrl() });
    await client.connect();
    // Sequenced: one shared pg.Client cannot run interleaved queries.
    const tenantA = await seedOneTenant(owner, "a");
    const tenantB = await seedOneTenant(owner, "b");
    ORG_A = tenantA.orgId;
    PROP_A = tenantA.propertyId;
    CONV_A = tenantA.conversationId;
    ORG_B = tenantB.orgId;
    PROP_B = tenantB.propertyId;
    CONV_B = tenantB.conversationId;
  });

  afterAll(async () => {
    await owner.end();
    await client.end();
    await dropScratch();
  });

  it("S01-03: the suite derives the tenant-table list FROM the database (policies, not hardcoded drift)", async () => {
    const scoped = await tenantTablesByPolicy(owner);
    expect([...scoped].sort()).toEqual([...EXPECTED_TENANT_TABLES].sort());
    // and the whole 25 split cleanly: scoped + global = plan tables
    const allTables = await owner.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'schema_migrations'",
    );
    const names = allTables.rows.map((r) => r.tablename).sort();
    expect(names).toHaveLength(25);
    expect(names).toEqual(
      [...EXPECTED_TENANT_TABLES, ...EXPECTED_GLOBAL_TABLES].sort(),
    );
  });

  it("S01-02 AC: a query without tenant context returns zero rows - EVERY tenant table", async () => {
    await asTenantApp(client, async () => {
      for (const table of EXPECTED_TENANT_TABLES) {
        const res = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        expect(res.rows[0]!.n).toBe("0");
      }
    });
  });

  it("S01-03 AC: every tenant table leaks nothing across tenants (both directions)", async () => {
    await asTenantApp(client, async () => {
      for (const table of EXPECTED_TENANT_TABLES) {
        // Ground truth from the owner session; the sweep must reproduce it
        // exactly, which is only possible if RLS splits rows precisely
        // along the (org, property) context.
        const expectedA = await ownerCount(owner, table, ORG_A);
        const expectedB = await ownerCount(owner, table, ORG_B);
        expect(expectedA).toBeGreaterThan(0);
        expect(expectedB).toBeGreaterThan(0);

        await setTenantContext(client, ORG_A, PROP_A);
        const ownA = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        expect(ownA.rows[0]!.n).toBe(String(expectedA));

        await setTenantContext(client, ORG_B, PROP_B);
        const ownB = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        expect(ownB.rows[0]!.n).toBe(String(expectedB));
      }
    });
  });

  it("cross-tenant context cannot write into org-scoped tables", async () => {
    await asTenantApp(client, async () => {
      await setTenantContext(client, ORG_B, PROP_B);
      await expect(
        client.query(
          "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'injected', 'injected')",
          [ORG_A],
        ),
      ).rejects.toThrow(/policy|row-level security|permission denied/i);
    });
  });

  it("cross-tenant context cannot write into property-scoped tables", async () => {
    await asTenantApp(client, async () => {
      await setTenantContext(client, ORG_B, PROP_B);
      await expect(
        client.query(
          `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body)
           VALUES ($1, $2, $3, 'inbound', 'guest', 'smuggled')`,
          [ORG_A, PROP_A, CONV_B],
        ),
      ).rejects.toThrow(/policy|row-level security|permission denied/i);
    });
  });

  it("mismatched org/property context pairs also yield zero rows", async () => {
    await asTenantApp(client, async () => {
      await setTenantContext(client, ORG_A, PROP_B);
      const res = await client.query<{ n: string }>("SELECT count(*) AS n FROM conversations");
      expect(res.rows[0]!.n).toBe("0");
    });
  });

  it("composite FKs: B context cannot reference A's conversation (P1 review finding)", async () => {
    // RLS hides A's rows from B, but a known ID could still be smuggled into a
    // single-column FK — the composite tenant FK makes that impossible.
    await asTenantApp(client, async () => {
      await setTenantContext(client, ORG_B, PROP_B);
      await expect(
        client.query(
          `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body)
           VALUES ($1, $2, $3, 'inbound', 'guest', 'cross-tenant reference')`,
          [ORG_B, PROP_B, CONV_A],
        ),
      ).rejects.toThrow(/violates foreign key/);
    });
  });

  it("mispaired org/property values cannot be written even in a valid own context (pair FK)", async () => {
    await asTenantApp(client, async () => {
      await setTenantContext(client, ORG_B, PROP_B);
      // B's org + A's property: RLS `with check` fires first — the row's
      // tenant columns must match the context.
      await expect(
        client.query(
          `INSERT INTO outbox (org_id, property_id, kind, payload)
           VALUES ($1, $2, 'webhook', '{}')`,
          [ORG_B, PROP_A],
        ),
      ).rejects.toThrow(/violates row-level security/);
    });
    // Without RLS context (bypassing session), the pair uniqueness still
    // holds at the FK level: (org B, property A) is not a real pairing.
    await expect(
      owner.query(
        `INSERT INTO outbox (org_id, property_id, kind, payload)
         VALUES ($1, $2, 'webhook', '{}')`,
        [ORG_B, PROP_A],
      ),
    ).rejects.toThrow(/violates foreign key/);
  });

  it("promote_article_version is scoped to the CALLER's tenant", async () => {
    const aVersion = await owner.query<{ article_version_id: string }>(
      "SELECT article_version_id FROM article_versions WHERE org_id = $1 ORDER BY article_version_id LIMIT 1",
      [ORG_A],
    );
    const bVersion = await owner.query<{ article_version_id: string }>(
      "SELECT article_version_id FROM article_versions WHERE org_id = $1 ORDER BY article_version_id LIMIT 1",
      [ORG_B],
    );
    const bId = bVersion.rows[0]!.article_version_id;
    const aId = aVersion.rows[0]!.article_version_id;
    const vector = `[${Array.from({ length: 1536 }, () => 0).join(",")}]`;

    // No context = no promotion (fresh transaction, no tenant context set).
    await asTenantApp(client, async () => {
      await expect(
        client.query("SELECT promote_article_version($1)", [bId]),
      ).rejects.toThrow(/tenant context/);
    });

    await asTenantApp(client, async () => {
      await setTenantContext(client, ORG_B, PROP_B);
      // With the caller's own context: embed first, then promote works.
      await client.query(
        "UPDATE article_versions SET embedding = $2 WHERE article_version_id = $1",
        [bId, vector],
      );
      await client.query("SELECT promote_article_version($1)", [bId]);
      const current = await client.query<{ version_no: number }>(
        "SELECT version_no FROM article_versions WHERE property_id = $1 AND is_current",
        [PROP_B],
      );
      expect(current.rows).toHaveLength(1);
      // The whole point: a KNOWN foreign version id cannot be promoted —
      // the definer lookup is not filtered by RLS, so the function checks
      // the caller context explicitly.
      await expect(
        client.query("SELECT promote_article_version($1)", [aId]),
      ).rejects.toThrow(/another tenant/);
    });
  });
});

/* ---------- helpers ---------- */

function asTenantApp(
  client: pg.Client,
  fn: () => Promise<void>,
): Promise<void> {
  return client
    .query("BEGIN")
    .then(() => client.query("SET LOCAL ROLE concierge_app"))
    .then(fn)
    .finally(() => client.query("COMMIT"));
}

function setTenantContext(
  client: pg.Client,
  orgId: string,
  propertyId: string,
): Promise<void> {
  return client
    .query(
      `SELECT set_config('app.current_org_id', $1, true),
              set_config('app.current_property_id', $2, true)`,
      [orgId, propertyId],
    )
    .then(() => undefined);
}

function ownerCount(
  owner: pg.Client,
  table: string,
  orgId: string,
): Promise<number> {
  return owner
    .query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE org_id = $1`, [orgId])
    .then((r) => Number(r.rows[0]!.n));
}

async function tenantTablesByPolicy(client: pg.Client): Promise<Set<string>> {
  const policyRes = await client.query<{ tablename: string }>(
    "SELECT DISTINCT tablename FROM pg_policies WHERE policyname = $1 AND schemaname = 'public'",
    [TENANT_POLICY],
  );
  return new Set(policyRes.rows.map((r) => r.tablename));
}

interface SeedResult {
  orgId: string;
  propertyId: string;
  conversationId: string;
}

/** Seeds one full tenant graph covering every tenant table, as the owner. */
async function seedOneTenant(client: pg.Client, tag: "a" | "b"): Promise<SeedResult> {
  const prefix = `s01_${tag}_${Math.random().toString(16).slice(2, 10)}`;
  const org = await client.query<{ org_id: string }>(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING org_id",
    [prefix, prefix],
  );
  const ORG = org.rows[0]!.org_id;
  const prop = await client.query<{ property_id: string }>(
    "INSERT INTO properties (org_id, name, slug) VALUES ($1, $2, $2) RETURNING property_id",
    [ORG, prefix],
  );
  const PROP = prop.rows[0]!.property_id;

  const chan = await client.query<{ channel_connection_id: string }>(
    "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web') RETURNING channel_connection_id",
    [ORG, PROP],
  );
  const CHAN = chan.rows[0]!.channel_connection_id;

  const ident = await client.query<{ identity_id: string }>(
    `INSERT INTO channel_identities (org_id, property_id, connection_id, external_id, display_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING identity_id`,
    [ORG, PROP, CHAN, `ext_${tag}_1`, `guest ${tag}`],
  );
  const IDENT = ident.rows[0]!.identity_id;

  const conv = await client.query<{ conversation_id: string }>(
    `INSERT INTO conversations (org_id, property_id, connection_id, identity_id, language, status)
     VALUES ($1, $2, $3, $4, 'es', 'open') RETURNING conversation_id`,
    [ORG, PROP, CHAN, IDENT],
  );
  const CONV = conv.rows[0]!.conversation_id;

  const msg = await client.query<{ message_id: string }>(
    `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body, language)
     VALUES ($1, $2, $3, 'inbound', 'guest', 'pool hours', 'es') RETURNING message_id`,
    [ORG, PROP, CONV],
  );
  const MSG = msg.rows[0]!.message_id;

  await client.query(
    `INSERT INTO message_delivery_events (org_id, property_id, message_id, stage, provider_message_id)
     VALUES ($1, $2, $3, 'delivered', $4)`,
    [ORG, PROP, MSG, `prov_${tag}`],
  );

  const req = await client.query<{ request_id: string }>(
    `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status)
     VALUES ($1, $2, $3, 'do_not_disturb', 'new') RETURNING request_id`,
    [ORG, PROP, CONV],
  );
  const REQ = req.rows[0]!.request_id;

  const user = await client.query<{ user_id: string }>(
    "INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING user_id",
    [`staff_${prefix}@example.com`, `staff ${prefix}`],
  );
  const USER = user.rows[0]!.user_id;

  await client.query(
    "INSERT INTO assignments (org_id, property_id, request_id, assigned_to) VALUES ($1, $2, $3, $4)",
    [ORG, PROP, REQ, USER],
  );
  await client.query(
    `INSERT INTO internal_notes (org_id, property_id, conversation_id, request_id, author_user_id, body)
     VALUES ($1, $2, $3, $4, $5, 'front desk reply sent')`,
    [ORG, PROP, CONV, REQ, USER],
  );

  const src = await client.query<{ source_id: string }>(
    "INSERT INTO knowledge_sources (org_id, property_id, kind, title) VALUES ($1, $2, 'manual', $3) RETURNING source_id",
    [ORG, PROP, `collected ${prefix}`],
  );
  const SRC = src.rows[0]!.source_id;

  const article = await client.query<{ article_id: string }>(
    `INSERT INTO knowledge_articles (org_id, property_id, source_id, scope, topic_key, title, language)
     VALUES ($1, $2, $3, 'property', 'pool.hours', $4, 'es') RETURNING article_id`,
    [ORG, PROP, SRC, `pool schedule ${prefix}`],
  );
  const ARTICLE = article.rows[0]!.article_id;

  const ver = await client.query<{ article_version_id: string }>(
    `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
     VALUES ($1, $2, $3, 1, 'The pool closes at 20:00.') RETURNING article_version_id`,
    [ORG, PROP, ARTICLE],
  );
  const VERSION = ver.rows[0]!.article_version_id;

  await client.query(
    `INSERT INTO property_facts (org_id, property_id, source_id, topic_key, fact_key, fact_value, language, verified)
     VALUES ($1, $2, $3, 'pool.hours', 'closing', '20:00', 'es', true)`,
    [ORG, PROP, SRC],
  );

  const run = await client.query<{ ai_run_id: string }>(
    `INSERT INTO ai_runs (org_id, property_id, conversation_id, message_id, model_id, prompt_version, decision, confidence, latency_ms)
     VALUES ($1, $2, $3, $4, 'baseline-model', 'v1', 'answer', 0.90, 950) RETURNING ai_run_id`,
    [ORG, PROP, CONV, MSG],
  );
  const RUN = run.rows[0]!.ai_run_id;

  await client.query(
    "INSERT INTO citations (org_id, property_id, ai_run_id, article_version_id) VALUES ($1, $2, $3, $4)",
    [ORG, PROP, RUN, VERSION],
  );
  await client.query(
    `INSERT INTO handoff_reasons (org_id, property_id, conversation_id, reason_code)
     VALUES ($1, $2, $3, 'refresh_needed')`,
    [ORG, PROP, CONV],
  );
  await client.query(
    `INSERT INTO knowledge_gaps (org_id, property_id, conversation_id, question, language, status)
     VALUES ($1, $2, $3, 'why wrote ends at 21:00', 'es', 'open')`,
    [ORG, PROP, CONV],
  );
  await client.query(
    `INSERT INTO events (org_id, property_id, conversation_id, channel, event_type, payload)
     VALUES ($1, $2, $3, 'web', 'conversation_started', '{}')`,
    [ORG, PROP, CONV],
  );
  await client.query(
    `INSERT INTO rollups (org_id, property_id, metric, window_start, value)
     VALUES ($1, $2, 'containment', current_date, 0.55)`,
    [ORG, PROP],
  );
  await client.query(
    `INSERT INTO audit_log (org_id, property_id, actor_user_id, action, entity_type, entity_id)
     VALUES ($1, $2, $3, 'properties.updated', 'properties', $4)`,
    [ORG, PROP, USER, PROP],
  );
  await client.query(
    `INSERT INTO outbox (org_id, property_id, kind, payload, status)
     VALUES ($1, $2, 'provider_message', '{"message_id":"m1"}', 'pending')`,
    [ORG, PROP],
  );

  return { orgId: ORG, propertyId: PROP, conversationId: CONV };
}
