import { spawnSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { FIXTURE_ARTICLES, FIXTURE_FACTS } from "../../src/fixtures/fixture-hotel.ts";
import { chunkBody } from "../../src/knowledge/chunk.ts";
import {
  DEMO_GAP_ID,
  DEMO_ORG_ID,
  DEMO_PROPERTY_ID,
  DEMO_STAFF,
  stableUuid,
} from "../../src/seed/ids.ts";
import { seedDemo } from "../../src/seed/demo.ts";
import { parsePropertySettings } from "../../src/settings/schema.ts";
import {
  connectScratch,
  dropScratch,
  recreateScratch,
  scratchAdminUrl,
  scratchUrl,
} from "./helpers.db.ts";

const CLI_DB = `seed_cli_${process.pid}`;

let client: pg.Client;

async function runSeed(): Promise<void> {
  await client.query("BEGIN");
  try {
    await seedDemo(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function counts(): Promise<Record<string, number>> {
  const result = await client.query<{
    orgs: string;
    properties: string;
    users: string;
    memberships: string;
    knowledge_sources: string;
    knowledge_articles: string;
    article_versions: string;
    property_facts: string;
    knowledge_gaps: string;
    article_chunks: string;
  }>(
    `SELECT
       (SELECT count(*) FROM organizations WHERE org_id = $1) AS orgs,
       (SELECT count(*) FROM properties WHERE property_id = $2) AS properties,
       (SELECT count(*) FROM users WHERE user_id = ANY($3::uuid[])) AS users,
       (SELECT count(*) FROM memberships WHERE property_id = $2) AS memberships,
       (SELECT count(*) FROM knowledge_sources WHERE property_id = $2) AS knowledge_sources,
       (SELECT count(*) FROM knowledge_articles WHERE property_id = $2) AS knowledge_articles,
       (SELECT count(*) FROM article_versions WHERE property_id = $2) AS article_versions,
       (SELECT count(*) FROM property_facts WHERE property_id = $2) AS property_facts,
       (SELECT count(*) FROM knowledge_gaps WHERE property_id = $2) AS knowledge_gaps,
       (SELECT count(*) FROM article_chunks WHERE property_id = $2) AS article_chunks`,
    [DEMO_ORG_ID, DEMO_PROPERTY_ID, DEMO_STAFF.map((staff) => staff.userId)],
  );
  const row = result.rows[0]!;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  );
}

async function version(id: string): Promise<{
  body: string | null;
  is_current: boolean;
  promoted_at: Date | null;
  embedding_is_null: boolean;
}> {
  const result = await client.query<{
    body: string | null;
    is_current: boolean;
    promoted_at: Date | null;
    embedding_is_null: boolean;
  }>(
    `SELECT body, is_current, promoted_at, embedding IS NULL AS embedding_is_null
       FROM article_versions WHERE article_version_id = $1`,
    [id],
  );
  return result.rows[0]!;
}

describe("demo seed (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
    const admin = new pg.Client({ connectionString: scratchAdminUrl() });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${CLI_DB} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("populates the exact demo graph on an empty migrated database", async () => {
    await runSeed();
    expect(await counts()).toEqual({
      orgs: 1,
      properties: 1,
      users: 4,
      memberships: 4,
      knowledge_sources: 1,
      knowledge_articles: FIXTURE_ARTICLES.length,
      article_versions: FIXTURE_ARTICLES.length,
      property_facts: FIXTURE_FACTS.length,
      knowledge_gaps: 1,
      // S04-02: the demo's published versions are chunked, so a fresh database
      // satisfies AC-1 without an embedding API key. Computed from the fixture
      // so a corpus change does not break the count.
      article_chunks: FIXTURE_ARTICLES.reduce(
        (sum, a) => sum + (a.body === null ? 0 : chunkBody(a.body).length),
        0,
      ),
    });

    const current = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM article_versions WHERE property_id = $1 AND is_current",
      [DEMO_PROPERTY_ID],
    );
    expect(Number(current.rows[0]!.count)).toBe(FIXTURE_ARTICLES.length - 1);
    const promoted = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM article_versions
        WHERE property_id = $1 AND is_current AND promoted_at IS NOT NULL`,
      [DEMO_PROPERTY_ID],
    );
    expect(Number(promoted.rows[0]!.count)).toBe(FIXTURE_ARTICLES.length - 1);
  });

  it("is idempotent on a second run", async () => {
    const before = await counts();
    await runSeed();
    expect(await counts()).toEqual(before);
  });

  it("keeps the six messy cases intact", async () => {
    const menu = await version(FIXTURE_ARTICLES[0]!.articleVersionId);
    const menuLines = menu.body!.split("\n");
    expect(menuLines).toHaveLength(8);
    expect(menuLines.every((line) => line.includes("   $"))).toBe(true);

    const ocr = await version(FIXTURE_ARTICLES[1]!.articleVersionId);
    expect(ocr.body).toContain("fr0m");
    expect(ocr.body).toContain("quict");
    expect(ocr.body).toContain("resp3ct");

    const poolScopes = await client.query<{ article_id: string; scope: string }>(
      `SELECT article_id, scope FROM knowledge_articles
        WHERE article_id = ANY($1::uuid[])`,
      [
        [
          stableUuid(`article:${FIXTURE_ARTICLES[2]!.articleId}`),
          stableUuid(`article:${FIXTURE_ARTICLES[3]!.articleId}`),
        ],
      ],
    );
    expect(new Set(poolScopes.rows.map((row) => row.scope))).toEqual(
      new Set(["brand", "property"]),
    );
    const poolFacts = await client.query<{ fact_value: string; verified: boolean }>(
      `SELECT fact_value, verified FROM property_facts
        WHERE property_id = $1 AND topic_key = 'pool.hours' ORDER BY fact_value`,
      [DEMO_PROPERTY_ID],
    );
    expect(poolFacts.rows).toEqual([
      { fact_value: "20:00", verified: false },
      { fact_value: "21:00", verified: false },
    ]);

    const spa = await client.query<{ language: string | null }>(
      "SELECT language FROM knowledge_articles WHERE article_id = $1",
      [stableUuid(`article:${FIXTURE_ARTICLES[4]!.articleId}`)],
    );
    expect(spa.rows[0]!.language).toBe("es");
    const spaFacts = await client.query<{ language: string }>(
      `SELECT language FROM property_facts
        WHERE property_id = $1 AND topic_key = 'spa.services'`,
      [DEMO_PROPERTY_ID],
    );
    expect(spaFacts.rows.map((row) => row.language)).toEqual(["fr", "fr"]);

    const marketing = await version(FIXTURE_ARTICLES[5]!.articleVersionId);
    const paragraphs = marketing.body!.split("\n\n");
    expect(marketing.body!.split(/\s+/).length).toBeGreaterThanOrEqual(3000);
    expect(paragraphs[10]).toContain("gym.hours is 24/7");

    const noticeboard = await version(FIXTURE_ARTICLES[6]!.articleVersionId);
    expect(noticeboard.body).toBeNull();
    expect(noticeboard.embedding_is_null).toBe(true);
    expect(noticeboard.is_current).toBe(false);
    expect(noticeboard.promoted_at).toBeNull();

    const gap = await client.query<{ question: string; language: string; status: string }>(
      "SELECT question, language, status FROM knowledge_gaps WHERE gap_id = $1",
      [DEMO_GAP_ID],
    );
    expect(gap.rows[0]).toEqual({
      question: "Parking policy article has no extractable text (noticeboard photo)",
      language: "es",
      status: "open",
    });
  });

  it("stores valid demo settings and the fixture topics", async () => {
    const property = await client.query<{
      time_zone: string;
      ai_mode: string;
      settings: unknown;
    }>(
      "SELECT time_zone, ai_mode, settings FROM properties WHERE property_id = $1",
      [DEMO_PROPERTY_ID],
    );
    expect(property.rows[0]!.time_zone).toBe("America/Mexico_City");
    expect(property.rows[0]!.ai_mode).toBe("auto");
    const settings = parsePropertySettings(property.rows[0]!.settings);
    const expectedTopics = [...new Set(FIXTURE_ARTICLES.map((a) => a.topicKey))];
    expect(settings.enabled_topics).toEqual(expectedTopics);
    expect(FIXTURE_FACTS).toHaveLength(FIXTURE_FACTS.length);
  });

  it("keeps the demo rows invisible to another property's context", async () => {
    const otherOrg = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('other', 'seed_other') RETURNING org_id",
    );
    const otherProperty = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Other', 'seed_other') RETURNING property_id",
      [otherOrg.rows[0]!.org_id],
    );

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE concierge_app");
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [
        otherOrg.rows[0]!.org_id,
      ]);
      await client.query("SELECT set_config('app.current_property_id', $1, true)", [
        otherProperty.rows[0]!.property_id,
      ]);
      const articles = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM knowledge_articles",
      );
      const versions = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM article_versions",
      );
      expect(Number(articles.rows[0]!.count)).toBe(0);
      expect(Number(versions.rows[0]!.count)).toBe(0);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("refuses APP_ENV=prod before connecting and seeds through the CLI otherwise", async () => {
    const admin = new pg.Client({ connectionString: scratchAdminUrl() });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${CLI_DB} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${CLI_DB}`);
    } finally {
      await admin.end();
    }
    await migrateDatabase(scratchUrl(CLI_DB));

    const refused = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/seed.ts", "--url", scratchUrl(CLI_DB)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, APP_ENV: "prod" },
      },
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("refusing to run with APP_ENV=prod");

    const probe = new pg.Client({ connectionString: scratchUrl(CLI_DB) });
    await probe.connect();
    try {
      const empty = await probe.query<{ count: string }>(
        "SELECT count(*) AS count FROM organizations",
      );
      expect(Number(empty.rows[0]!.count)).toBe(0);
    } finally {
      await probe.end();
    }

    const seeded = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/seed.ts", "--url", scratchUrl(CLI_DB)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, APP_ENV: "staging" },
      },
    );
    expect(seeded.status).toBe(0);
    const summary = JSON.parse(seeded.stdout.trim().split(/\r?\n/).at(-1)!) as Record<
      string,
      number
    >;
    expect(summary).toEqual({
      orgs: 1,
      properties: 1,
      users: 4,
      memberships: 4,
      knowledge_sources: 1,
      knowledge_articles: FIXTURE_ARTICLES.length,
      article_versions: FIXTURE_ARTICLES.length,
      property_facts: FIXTURE_FACTS.length,
      knowledge_gaps: 1,
      article_chunks: FIXTURE_ARTICLES.reduce(
        (sum, a) => sum + (a.body === null ? 0 : chunkBody(a.body).length),
        0,
      ),
    });
  });
});
