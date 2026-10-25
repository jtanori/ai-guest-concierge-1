/**
 * S03-03 - deterministic facts under RLS.
 *
 * The AC's shape is literal: the pool closing time comes back from a verified
 * row (or not at all), never from a model. The fixture's two pool facts share
 * (topic, fact_key, language, effective_from) with different values, so they
 * are the contradiction case the whole item exists for - until a human picks
 * one, lookup must answer nothing and verifyFact must refuse the second.
 */
import crypto from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditWriteError } from "../../src/audit/write.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import {
  FactActorError,
  FactContradictionError,
  FactNotFoundError,
  FactSourceVersionNotFoundError,
  FactValidationError,
  FactVerificationError,
  createFact,
  getFact,
  listContradictions,
  listFacts,
  lookupFact,
  updateFact,
  verifyFact,
  type FactInput,
} from "../../src/knowledge/facts.ts";
import { FIXTURE_FACTS } from "../../src/fixtures/fixture-hotel.ts";
import { seedDemo } from "../../src/seed/demo.ts";
import { DEMO_ORG_ID, DEMO_PROPERTY_ID, DEMO_STAFF, stableUuid } from "../../src/seed/ids.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

let client: pg.Client;
let demo: TenantContext;
let tenantA: TenantContext;
let tenantB: TenantContext;
let actorA: { userId: string };
let actorB: { userId: string };
let demoActor: { userId: string };
let sourceA: string;
let versionA: string;

const factIdOf = (factId: string): string => stableUuid(`fact:${factId}`);
const poolWebsite = FIXTURE_FACTS.find((f) => f.value === "21:00")!;
const poolDirectory = FIXTURE_FACTS.find((f) => f.value === "20:00")!;

function input(overrides: Partial<FactInput> = {}): FactInput {
  return {
    topicKey: "spa.services",
    factKey: "sauna_minutes",
    value: "30 min",
    unit: "duration",
    language: "en",
    effectiveFrom: "2026-03-01",
    ...overrides,
  };
}

async function asApp<T>(
  context: TenantContext,
  fn: (tx: pg.Client) => Promise<T>,
): Promise<T> {
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

async function auditActions(propertyId: string): Promise<string[]> {
  const result = await client.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE property_id = $1 ORDER BY audit_id",
    [propertyId],
  );
  return result.rows.map((row) => row.action);
}

describe("property facts (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    await client.query("BEGIN");
    try {
      await seedDemo(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    demo = { orgId: DEMO_ORG_ID, propertyId: DEMO_PROPERTY_ID };
    demoActor = { userId: DEMO_STAFF[0]!.userId };

    const orgA = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Facts A', 'facts_a') RETURNING org_id",
    );
    const orgB = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Facts B', 'facts_b') RETURNING org_id",
    );
    const propertyA = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Facts A', 'facts_property_a') RETURNING property_id",
      [orgA.rows[0]!.org_id],
    );
    const propertyB = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Facts B', 'facts_property_b') RETURNING property_id",
      [orgB.rows[0]!.org_id],
    );
    tenantA = { orgId: orgA.rows[0]!.org_id, propertyId: propertyA.rows[0]!.property_id };
    tenantB = { orgId: orgB.rows[0]!.org_id, propertyId: propertyB.rows[0]!.property_id };

    const userA = await client.query<{ user_id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('facts-a@example.mx', 'Facts A') RETURNING user_id",
    );
    const userB = await client.query<{ user_id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('facts-b@example.mx', 'Facts B') RETURNING user_id",
    );
    actorA = { userId: userA.rows[0]!.user_id };
    actorB = { userId: userB.rows[0]!.user_id };

    sourceA = await asApp(tenantA, async (tx) => {
      const row = await tx.query<{ source_id: string }>(
        `INSERT INTO knowledge_sources (org_id, property_id, kind, title)
         VALUES ($1, $2, 'manual', 'Facts A manual') RETURNING source_id`,
        [tenantA.orgId, tenantA.propertyId],
      );
      return row.rows[0]!.source_id;
    });
    versionA = await asApp(tenantA, async (tx) => {
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, source_id, scope, topic_key, title, language)
         VALUES ($1, $2, $3, 'property', 'spa.services', 'Spa menu', 'en') RETURNING article_id`,
        [tenantA.orgId, tenantA.propertyId, sourceA],
      );
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
         VALUES ($1, $2, $3, 1, 'Sauna is 30 minutes.') RETURNING article_version_id`,
        [tenantA.orgId, tenantA.propertyId, article.rows[0]!.article_id],
      );
      return version.rows[0]!.article_version_id;
    });
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("0009 lands: new columns, the three constraints, the dropped unique and the two indexes", async () => {
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'property_facts'`,
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const column of [
      "unit",
      "effective_from",
      "source_article_version_id",
      "verified_by",
      "verified_at",
    ]) {
      expect(names.has(column), column).toBe(true);
    }

    const constraints = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'property_facts'::regclass`,
    );
    const connames = new Set(constraints.rows.map((row) => row.conname));
    for (const name of [
      "property_facts_unit_check",
      "property_facts_verified_fields",
      "property_facts_source_version_fk",
    ]) {
      expect(connames.has(name), name).toBe(true);
    }
    // 0001's key is gone: two rows must be able to share a key (AC-2/AC-3)
    expect(connames.has("property_facts_property_id_topic_key_fact_key_language_key")).toBe(
      false,
    );

    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'property_facts'",
    );
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.has("property_facts_lookup")).toBe(true);
    const verifiedKey = byName.get("property_facts_verified_key") ?? "";
    expect(verifiedKey).toMatch(/^CREATE UNIQUE INDEX/);
    expect(verifiedKey).toMatch(/\(property_id, topic_key, fact_key, language, effective_from\)/);
    expect(verifiedKey).toMatch(/WHERE verified\b/);
  });

  it("seeds 5 facts with unit, effective date and source VERSION; pool shares closing_time, spa keys differ", async () => {
    const rows = await client.query<{
      fact_key: string;
      topic_key: string;
      unit: string;
      effective_from: string;
      source_article_version_id: string;
      verified: boolean;
      fact_value: string;
    }>(
      `SELECT fact_key, topic_key, unit,
              to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
              source_article_version_id, verified, fact_value
         FROM property_facts
        WHERE property_id = $1
        ORDER BY fact_key, fact_value`,
      [DEMO_PROPERTY_ID],
    );
    expect(rows.rows).toHaveLength(5);
    for (const row of rows.rows) {
      expect(row.unit, row.fact_key).not.toBe("");
      expect(row.effective_from, row.fact_key).toBe("2026-01-01");
      expect(row.source_article_version_id, row.fact_key).toBeTruthy();
      expect(row.verified, row.fact_key).toBe(false);
    }

    const pool = rows.rows.filter((row) => row.topic_key === "pool.hours");
    expect(pool.map((row) => row.fact_key)).toEqual(["closing_time", "closing_time"]);
    expect(new Set(pool.map((row) => row.fact_value))).toEqual(new Set(["21:00", "20:00"]));

    const spa = rows.rows.filter((row) => row.topic_key === "spa.services");
    expect(new Set(spa.map((row) => row.fact_key))).toEqual(
      new Set(["facial", "massage_60"]),
    );
  });

  it("answers nothing while both pool facts are unverified (AC-2: no guess)", async () => {
    const hit = await asApp(demo, (tx) =>
      lookupFact(tx, demo, { topicKey: "pool.hours", factKey: "closing_time", language: "es" }),
    );
    expect(hit).toBeNull();

    // a key nobody has ever entered is the same answer: null, not a guess
    const unknown = await asApp(demo, (tx) =>
      lookupFact(tx, demo, { topicKey: "pool.hours", factKey: "quiet_hours", language: "es" }),
    );
    expect(unknown).toBeNull();
  });

  it("verifies one pool value, refuses the other, then answers by lookup (AC-1, AC-3)", async () => {
    const websiteId = factIdOf(poolWebsite.factId);
    const directoryId = factIdOf(poolDirectory.factId);

    const verified = await asApp(demo, (tx) => verifyFact(tx, demo, demoActor, websiteId));
    expect(verified.factId).toBe(websiteId);

    const clash = await asApp(demo, (tx) =>
      verifyFact(tx, demo, demoActor, directoryId),
    ).catch((error: unknown) => error);
    expect(clash).toBeInstanceOf(FactContradictionError);
    const error = clash as FactContradictionError;
    expect(error.factId).toBe(directoryId);
    expect(error.conflictingFactId).toBe(websiteId);
    expect(error.conflictingValue).toBe("21:00");

    const hit = await asApp(demo, (tx) =>
      lookupFact(tx, demo, { topicKey: "pool.hours", factKey: "closing_time", language: "es" }),
    );
    expect(hit).toEqual({ value: "21:00", unit: "time-of-day", effectiveFrom: "2026-01-01" });

    const row = await client.query<{ verified_by: string; verified_at: Date }>(
      "SELECT verified_by, verified_at FROM property_facts WHERE fact_id = $1",
      [websiteId],
    );
    expect(row.rows[0]!.verified_by).toBe(DEMO_STAFF[0]!.userId);
    expect(row.rows[0]!.verified_at).toBeInstanceOf(Date);

    const refused = await client.query<{ verified: boolean }>(
      "SELECT verified FROM property_facts WHERE fact_id = $1",
      [directoryId],
    );
    expect(refused.rows[0]!.verified).toBe(false);

    expect(await auditActions(DEMO_PROPERTY_ID)).toEqual(
      expect.arrayContaining(["fact.verified"]),
    );
  });

  it("honours the effective date: a fact is invisible before it takes effect", async () => {
    const before = await asApp(demo, (tx) =>
      lookupFact(tx, demo, {
        topicKey: "pool.hours",
        factKey: "closing_time",
        language: "es",
        on: "2025-12-31",
      }),
    );
    expect(before).toBeNull();

    const on = await asApp(demo, (tx) =>
      lookupFact(tx, demo, {
        topicKey: "pool.hours",
        factKey: "closing_time",
        language: "es",
        on: "2026-01-01",
      }),
    );
    expect(on?.value).toBe("21:00");

    const badDate = await asApp(demo, (tx) =>
      lookupFact(tx, demo, {
        topicKey: "pool.hours",
        factKey: "closing_time",
        language: "es",
        on: "soon",
      }),
    ).catch((error: unknown) => error);
    expect(badDate).toBeInstanceOf(FactValidationError);
  });

  it("the database itself refuses a verified fact stripped of its verifier", async () => {
    const websiteId = factIdOf(poolWebsite.factId);
    await expect(
      asApp(demo, (tx) =>
        tx.query("UPDATE property_facts SET verified_by = NULL WHERE fact_id = $1", [
          websiteId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const stillVerified = await client.query<{ verified: boolean; verified_by: string }>(
      "SELECT verified, verified_by FROM property_facts WHERE fact_id = $1",
      [websiteId],
    );
    expect(stillVerified.rows[0]!.verified).toBe(true);
    expect(stillVerified.rows[0]!.verified_by).toBe(DEMO_STAFF[0]!.userId);
  });

  it("lists the pool pair as a contradiction and leaves the two spa prices alone", async () => {
    const found = await asApp(demo, (tx) => listContradictions(tx, demo));
    expect(found).toHaveLength(1);
    const pool = found[0]!;
    expect(pool.topicKey).toBe("pool.hours");
    expect(pool.factKey).toBe("closing_time");
    expect(pool.language).toBe("es");
    expect(pool.effectiveFrom).toBe("2026-01-01");
    expect(pool.entries.map((entry) => entry.value).sort()).toEqual(["20:00", "21:00"]);
    // both sides are reported, verified or not, so S04-01 can show the queue
    expect(pool.entries.map((entry) => entry.verified).sort()).toEqual([false, true]);
    expect(new Set(pool.entries.map((entry) => entry.factId))).toEqual(
      new Set([factIdOf(poolWebsite.factId), factIdOf(poolDirectory.factId)]),
    );
    expect(pool.entries.every((entry) => entry.sourceArticleVersionId)).toBe(true);

    expect(found.some((c) => c.topicKey === "spa.services")).toBe(false);
    expect(found.some((c) => c.topicKey === "gym.hours")).toBe(false);
  });

  it("an update resets verification, and lookup falls back to answering nothing", async () => {
    const websiteId = factIdOf(poolWebsite.factId);
    const before = await asApp(demo, (tx) =>
      getFact(tx, demo, websiteId),
    );
    expect(before.verified).toBe(true);

    const updated = await asApp(demo, (tx) =>
      updateFact(tx, demo, demoActor, websiteId, {
        topicKey: poolWebsite.topicKey,
        factKey: poolWebsite.factKey,
        value: "21:30",
        unit: "time-of-day",
        language: "es",
        effectiveFrom: poolWebsite.effectiveFrom,
        sourceArticleVersionId: poolWebsite.sourceArticleVersionId,
      }),
    );
    expect(updated).toEqual({ factId: websiteId, verifiedReset: true });

    const after = await asApp(demo, (tx) => getFact(tx, demo, websiteId));
    expect(after.verified).toBe(false);
    expect(after.verifiedBy).toBeNull();
    expect(after.verifiedAt).toBeNull();
    expect(after.value).toBe("21:30");

    const hit = await asApp(demo, (tx) =>
      lookupFact(tx, demo, { topicKey: "pool.hours", factKey: "closing_time", language: "es" }),
    );
    expect(hit).toBeNull();

    // the seed writes its rows directly, so demo audit history starts here
    expect(await auditActions(DEMO_PROPERTY_ID)).toEqual(
      expect.arrayContaining(["fact.updated", "fact.verified"]),
    );
  });

  it("creates, reads back and audits a fact with its source version (AC-6)", async () => {
    const created = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ sourceArticleVersionId: versionA })),
    );
    expect(created.factId).toMatch(/^[0-9a-f-]{36}$/i);

    const detail = await asApp(tenantA, (tx) => getFact(tx, tenantA, created.factId));
    expect(detail).toMatchObject({
      factId: created.factId,
      topicKey: "spa.services",
      factKey: "sauna_minutes",
      value: "30 min",
      unit: "duration",
      language: "en",
      effectiveFrom: "2026-03-01",
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      // D5 cites the VERSION; source_id stays for the source document the
      // seed fills in, and the service never invents one (charter §5.1).
      sourceId: null,
      sourceArticleVersionId: versionA,
    });
    expect(detail.createdAt).toBeInstanceOf(Date);

    const listed = await asApp(tenantA, (tx) => listFacts(tx, tenantA));
    expect(listed.map((fact) => fact.factId)).toContain(created.factId);

    const actions = await auditActions(tenantA.propertyId);
    expect(actions.filter((action) => action === "fact.created")).toHaveLength(1);
    const audit = await client.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log
        WHERE property_id = $1 AND action = 'fact.created' AND entity_id = $2`,
      [tenantA.propertyId, created.factId],
    );
    expect(audit.rows[0]!.detail).toEqual({
      topic_key: "spa.services",
      fact_key: "sauna_minutes",
      unit: "duration",
      language: "en",
      effective_from: "2026-03-01",
    });
  });

  it("refuses a source version from another tenant as if it did not exist (AC-4)", async () => {
    const foreignVersion = await asApp(tenantB, async (tx) => {
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'pool.hours', 'B pool', 'en') RETURNING article_id`,
        [tenantB.orgId, tenantB.propertyId],
      );
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
         VALUES ($1, $2, $3, 1, 'B body') RETURNING article_version_id`,
        [tenantB.orgId, tenantB.propertyId, article.rows[0]!.article_id],
      );
      return version.rows[0]!.article_version_id;
    });

    await expect(
      asApp(tenantA, (tx) =>
        createFact(tx, tenantA, actorA, input({ sourceArticleVersionId: foreignVersion })),
      ),
    ).rejects.toBeInstanceOf(FactSourceVersionNotFoundError);
  });

  it("verification demands an actor: no actor, a malformed one, or an unknown user all refuse (AC-3)", async () => {
    const created = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "steam_room" })),
    );

    await expect(
      asApp(tenantA, (tx) => verifyFact(tx, tenantA, undefined as never, created.factId)),
    ).rejects.toBeInstanceOf(FactActorError);
    await expect(
      asApp(tenantA, (tx) => verifyFact(tx, tenantA, { userId: "not-a-uuid" }, created.factId)),
    ).rejects.toBeInstanceOf(FactActorError);
    await expect(
      asApp(tenantA, (tx) =>
        verifyFact(tx, tenantA, { userId: crypto.randomUUID() }, created.factId),
      ),
    ).rejects.toBeInstanceOf(FactActorError);

    const row = await client.query<{ verified: boolean; verified_by: string | null }>(
      "SELECT verified, verified_by FROM property_facts WHERE fact_id = $1",
      [created.factId],
    );
    expect(row.rows[0]!.verified).toBe(false);
    expect(row.rows[0]!.verified_by).toBeNull();
  });

  it("re-verifying the same fact is idempotent - the index bars a second ROW, not a second look", async () => {
    const created = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "steam_room" })),
    );
    await asApp(tenantA, (tx) => verifyFact(tx, tenantA, actorA, created.factId));

    const again = await asApp(tenantA, (tx) =>
      verifyFact(tx, tenantA, actorA, created.factId),
    );
    expect(again).toEqual({ factId: created.factId });

    const row = await client.query<{ verified: boolean; verified_by: string | null }>(
      "SELECT verified, verified_by FROM property_facts WHERE fact_id = $1",
      [created.factId],
    );
    expect(row.rows[0]!.verified).toBe(true);
    expect(row.rows[0]!.verified_by).toBe(actorA.userId);
  });

  it("updates reset verification and write an audit row (AC-6)", async () => {
    const created = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "updates_reset" })),
    );
    await asApp(tenantA, (tx) => verifyFact(tx, tenantA, actorA, created.factId));

    const unchanged = await asApp(tenantA, (tx) =>
      updateFact(tx, tenantA, actorA, created.factId, input({ factKey: "updates_reset" })),
    );
    expect(unchanged).toEqual({ factId: created.factId, verifiedReset: true });

    const after = await asApp(tenantA, (tx) => getFact(tx, tenantA, created.factId));
    expect(after.verified).toBe(false);

    // a second update of an already-unverified fact reports no reset
    const again = await asApp(tenantA, (tx) =>
      updateFact(tx, tenantA, actorA, created.factId, input({ factKey: "updates_reset" })),
    );
    expect(again.verifiedReset).toBe(false);

    const actions = await auditActions(tenantA.propertyId);
    expect(actions.filter((action) => action === "fact.updated").length).toBeGreaterThanOrEqual(2);
    expect(actions).toContain("fact.verified");
  });

  it("a failed audit write rolls the fact back with it (AC-6)", async () => {
    const before = await asApp(tenantA, async (tx) => {
      const rows = await tx.query<{ count: string }>(
        "SELECT count(*) AS count FROM property_facts WHERE property_id = $1",
        [tenantA.propertyId],
      );
      return Number(rows.rows[0]!.count);
    });

    await expect(
      asApp(tenantA, (tx) =>
        createFact(tx, tenantA, { userId: "not-a-uuid" }, input({ factKey: "rollback.fact" })),
      ),
    ).rejects.toBeInstanceOf(AuditWriteError);

    const after = await asApp(tenantA, async (tx) => {
      const rows = await tx.query<{ count: string }>(
        "SELECT count(*) AS count FROM property_facts WHERE property_id = $1",
        [tenantA.propertyId],
      );
      return Number(rows.rows[0]!.count);
    });
    expect(after).toBe(before);
  });

  it("another tenant's fact id is indistinguishable from an unknown one (AC-4)", async () => {
    const created = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "tenant.isolation" })),
    );

    await expect(
      asApp(tenantB, (tx) => getFact(tx, tenantB, created.factId)),
    ).rejects.toBeInstanceOf(FactNotFoundError);
    await expect(
      asApp(tenantB, (tx) =>
        updateFact(tx, tenantB, actorB, created.factId, input({ factKey: "tenant.isolation" })),
      ),
    ).rejects.toBeInstanceOf(FactNotFoundError);
    await expect(
      asApp(tenantB, (tx) => verifyFact(tx, tenantB, actorB, created.factId)),
    ).rejects.toBeInstanceOf(FactNotFoundError);
    await expect(
      asApp(tenantB, (tx) =>
        lookupFact(tx, tenantB, {
          topicKey: "spa.services",
          factKey: "sauna_minutes",
          language: "en",
        }),
      ),
    ).resolves.toBeNull();

    const listed = await asApp(tenantB, (tx) => listFacts(tx, tenantB));
    expect(listed.some((fact) => fact.factId === created.factId)).toBe(false);
  });

  it("a legacy fact with no effective date cannot be verified (the CHECK would fire)", async () => {
    const legacy = await asApp(tenantA, async (tx) => {
      const row = await tx.query<{ fact_id: string }>(
        `INSERT INTO property_facts
           (org_id, property_id, topic_key, fact_key, fact_value, language, unit, effective_from)
         VALUES ($1, $2, 'legacy.topic', 'legacy_key', 'old', 'en', 'text', NULL)
         RETURNING fact_id`,
        [tenantA.orgId, tenantA.propertyId],
      );
      return row.rows[0]!.fact_id;
    });

    await expect(
      asApp(tenantA, (tx) => verifyFact(tx, tenantA, actorA, legacy)),
    ).rejects.toBeInstanceOf(FactVerificationError);
  });
});
