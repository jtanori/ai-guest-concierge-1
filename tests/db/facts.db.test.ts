/**
 * S03-03 - deterministic facts under RLS, and a `verified` column that only
 * the database itself can move.
 *
 * The AC's shape is literal: the pool closing time comes back from a verified
 * row (or not at all), never from a model. The fixture's two pool facts share
 * (topic, fact_key, language, effective_from) with different values, so they
 * are the contradiction case the whole item exists for - until a human picks
 * one, lookup must answer nothing and verifyFact must refuse the second.
 *
 * The second half of the file is the P1 from review round 1: `verified` is
 * trust, so `concierge_app` may not write it, the table owner may not write
 * it, and nothing may change a fact's value while keeping its verification.
 * The probes below run as each of those roles on purpose.
 */
import crypto from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { seedDemo, type SeedSummary } from "../../src/seed/demo.ts";
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

/** 02:00Z is still 20:00 the PREVIOUS day in Mexico City (UTC-6). */
const CLOCK = new Date("2026-10-26T02:00:00Z");

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

function actorFor(context: TenantContext): { userId: string } {
  if (context.propertyId === demo.propertyId) return demoActor;
  if (context.propertyId === tenantA.propertyId) return actorA;
  if (context.propertyId === tenantB.propertyId) return actorB;
  throw new Error(`no default actor for property ${context.propertyId}`);
}

/**
 * What withStaffSession sets up: tenant GUCs, the app role, and the session
 * identity every fact write is bound to. `session = null` is the "no staff
 * session" case, a different `session` is the "actor is not the session user"
 * case.
 */
async function asStaff<T>(
  context: TenantContext,
  session: { userId: string } | null,
  fn: (tx: pg.Client) => Promise<T>,
): Promise<T> {
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    if (session !== null) {
      await tx.query("SELECT set_config('app.current_user_id', $1, true)", [session.userId]);
    }
    return fn(tx);
  });
}

function asApp<T>(
  context: TenantContext,
  fn: (tx: pg.Client) => Promise<T>,
): Promise<T> {
  return asStaff(context, actorFor(context), fn);
}

/** `scripts/seed.ts` shape: seedDemo needs a transaction (it uses a savepoint). */
async function seedDemoInTx(target: pg.Client): Promise<SeedSummary> {
  await target.query("BEGIN");
  try {
    const summary = await seedDemo(target);
    await target.query("COMMIT");
    return summary;
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  }
}

async function auditActions(propertyId: string): Promise<string[]> {
  const result = await client.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE property_id = $1 ORDER BY audit_id",
    [propertyId],
  );
  return result.rows.map((row) => row.action);
}

async function auditCount(propertyId: string, action: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*) AS count FROM audit_log WHERE property_id = $1 AND action = $2",
    [propertyId, action],
  );
  return Number(result.rows[0]!.count);
}

async function factRow(factId: string): Promise<{
  verified: boolean;
  verified_by: string | null;
  verified_at: Date | null;
  fact_value: string;
}> {
  const result = await client.query(
    "SELECT verified, verified_by, verified_at, fact_value FROM property_facts WHERE fact_id = $1",
    [factId],
  );
  return result.rows[0]!;
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
      "INSERT INTO properties (org_id, name, slug, time_zone) VALUES ($1, 'Facts A', 'facts_property_a', 'America/Mexico_City') RETURNING property_id",
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
    await client.query(
      "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 1), ($3, $4, 2)",
      [actorA.userId, tenantA.propertyId, actorB.userId, tenantB.propertyId],
    );

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

  it("0009 lands: columns, a NOT VALID verified CHECK, the dropped unique, both partial indexes, the guard and the narrowed ACL", async () => {
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

    const constraints = await client.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'property_facts'::regclass`,
    );
    const byName = new Map(constraints.rows.map((row) => [row.conname, row.convalidated]));
    expect(byName.has("property_facts_unit_check"), "unit_check").toBe(true);
    expect(byName.has("property_facts_source_version_fk"), "source_version_fk").toBe(true);
    // NOT VALID: a pre-0009 verified row has no effective_from, so a validated
    // CHECK would abort this migration before the seed could touch anything.
    expect(byName.get("property_facts_verified_fields")).toBe(false);
    // 0001's key is gone: two rows must be able to share a key (AC-2/AC-3)
    expect(byName.has("property_facts_property_id_topic_key_fact_key_language_key")).toBe(false);

    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'property_facts'",
    );
    const defs = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));

    const verifiedKey = defs.get("property_facts_verified_key") ?? "";
    expect(verifiedKey).toMatch(/^CREATE UNIQUE INDEX/);
    expect(verifiedKey).toMatch(/\(property_id, topic_key, fact_key, language, effective_from\)/);
    expect(verifiedKey).toMatch(/WHERE verified\b/);

    const lookup = defs.get("property_facts_lookup") ?? "";
    expect(lookup).toMatch(
      /\(property_id, topic_key, fact_key, language, effective_from DESC, created_at DESC\) WHERE verified/,
    );

    const triggers = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'property_facts'::regclass AND NOT tgisinternal`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toContain(
      "property_facts_guard_verification",
    );

    // The app writes the fact, never the verdict.
    for (const column of ["topic_key", "fact_value", "unit", "effective_from"]) {
      const check = await client.query<{ ok: boolean }>(
        "SELECT has_column_privilege('concierge_app', 'property_facts', $1, 'UPDATE') AS ok",
        [column],
      );
      expect(check.rows[0]!.ok, column).toBe(true);
    }
    for (const column of ["verified", "verified_by", "verified_at"]) {
      const check = await client.query<{ ok: boolean }>(
        "SELECT has_column_privilege('concierge_app', 'property_facts', $1, 'UPDATE') AS ok",
        [column],
      );
      expect(check.rows[0]!.ok, column).toBe(false);
    }
    const executor = await client.query<{ ok: boolean }>(
      `SELECT has_function_privilege('concierge_app', 'verify_property_fact(uuid, uuid)', 'EXECUTE') AS ok`,
    );
    expect(executor.rows[0]!.ok).toBe(true);
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
    expect(rows.rows).toHaveLength(FIXTURE_FACTS.length);
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
    const before = await auditCount(DEMO_PROPERTY_ID, "fact.verified");

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

    const row = await factRow(websiteId);
    expect(row.verified_by).toBe(DEMO_STAFF[0]!.userId);
    expect(row.verified_at).toBeInstanceOf(Date);
    expect((await factRow(directoryId)).verified).toBe(false);

    // exactly one fact.verified row per successful verification
    expect(await auditCount(DEMO_PROPERTY_ID, "fact.verified")).toBe(before + 1);
  });

  it("honours an explicit effective date: a fact is invisible before it takes effect", async () => {
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

  it("the property's timezone decides \"today\", with a fixed clock (P2)", async () => {
    const early = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "facts_morning", value: "06:00", unit: "time-of-day", effectiveFrom: "2026-10-25" })),
    );
    const late = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "facts_evening", value: "22:00", unit: "time-of-day", effectiveFrom: "2026-10-26" })),
    );
    await asApp(tenantA, (tx) => verifyFact(tx, tenantA, actorA, early.factId));
    await asApp(tenantA, (tx) => verifyFact(tx, tenantA, actorA, late.factId));

    // 02:00Z on 26 October is 20:00 on 25 October in America/Mexico_City, so
    // "today at the property" is 2026-10-25: the 25th answers, the 26th does
    // not - a UTC session date would have answered the wrong one.
    const localToday = await asApp(tenantA, (tx) =>
      lookupFact(tx, tenantA, {
        topicKey: "spa.services",
        factKey: "facts_morning",
        language: "en",
      }, CLOCK),
    );
    expect(localToday).toMatchObject({ value: "06:00", effectiveFrom: "2026-10-25" });

    const tomorrow = await asApp(tenantA, (tx) =>
      lookupFact(tx, tenantA, {
        topicKey: "spa.services",
        factKey: "facts_evening",
        language: "en",
      }, CLOCK),
    );
    expect(tomorrow).toBeNull();

    // an explicit `on` still wins over the resolved clock
    const explicit = await asApp(tenantA, (tx) =>
      lookupFact(tx, tenantA, {
        topicKey: "spa.services",
        factKey: "facts_evening",
        language: "en",
        on: "2026-10-26",
      }, CLOCK),
    );
    expect(explicit).toMatchObject({ value: "22:00" });

    await asApp(tenantA, (tx) => updateFact(tx, tenantA, actorA, early.factId, input({ factKey: "raw_probe_a", value: "06:00", unit: "time-of-day", effectiveFrom: "2026-10-25" })));
    await asApp(tenantA, (tx) => updateFact(tx, tenantA, actorA, late.factId, input({ factKey: "raw_probe_b", value: "22:00", unit: "time-of-day", effectiveFrom: "2026-10-26" })));
  });

  it("raw SQL cannot verify a fact, and cannot keep a verification while changing it (P1)", async () => {
    const held = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "raw_held" })),
    );
    const victim = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "raw_victim" })),
    );
    const spare = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "raw_spare" })),
    );
    for (const id of [held.factId, victim.factId]) {
      await asApp(tenantA, (tx) => verifyFact(tx, tenantA, actorA, id));
    }
    const audited = await auditCount(tenantA.propertyId, "fact.verified");

    // 1. the app role cannot even name the column
    await expect(
      asApp(tenantA, (tx) =>
        tx.query(
          "UPDATE property_facts SET verified = true, verified_by = $1, verified_at = now() WHERE fact_id = $2",
          [actorA.userId, victim.factId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp(tenantA, (tx) =>
        tx.query("UPDATE property_facts SET verified_by = NULL WHERE fact_id = $1", [
          held.factId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // 2. an insert that arrives verified is refused too
    await expect(
      asApp(tenantA, (tx) =>
        tx.query(
          `INSERT INTO property_facts (org_id, property_id, topic_key, fact_key, fact_value,
                                       verified, verified_by, verified_at)
           VALUES ($1, $2, 'raw.sql', 'born_verified', 'yes', true, $3, now())`,
          [tenantA.orgId, tenantA.propertyId, actorA.userId],
        ),
      ),
    ).rejects.toThrow(/verify_property_fact/);

    // 3. the table owner is refused as well - grants do not apply to it.
    //    Both probes are stamp-only: on a verified row the stamp is
    //    immutable, on an unverified one `verified` may only flip inside
    //    verify_property_fact().
    await expect(
      client.query("UPDATE property_facts SET verified_by = NULL WHERE fact_id = $1", [
        held.factId,
      ]),
    ).rejects.toThrow(/verify_property_fact/);
    await expect(
      client.query(
        `UPDATE property_facts SET verified = true, verified_by = $1, verified_at = now()
          WHERE fact_id = $2`,
        [actorA.userId, spare.factId],
      ),
    ).rejects.toThrow(/verify_property_fact/);

    // 4. the owner CAN rewrite a value, but the stale "verified" never
    //    travels with it: content change drops the verdict for every role.
    await client.query(
      `UPDATE property_facts SET fact_value = 'hijacked', verified = true,
              verified_by = $1, verified_at = now()
        WHERE fact_id = $2`,
      [actorA.userId, spare.factId],
    );
    expect(await factRow(spare.factId)).toMatchObject({
      fact_value: "hijacked",
      verified: false,
      verified_by: null,
      verified_at: null,
    });

    // 5. the CHECK is still the last word: with the guard off, stripping the
    //    verifier of a verified row is a 23514, not a silent success
    await client.query("ALTER TABLE property_facts DISABLE TRIGGER property_facts_guard_verification");
    try {
      await expect(
        client.query("UPDATE property_facts SET verified_by = NULL WHERE fact_id = $1", [
          held.factId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ALTER TABLE property_facts ENABLE TRIGGER property_facts_guard_verification");
    }

    // 6. content mutation drops the verification, whatever the role
    await asApp(tenantA, (tx) =>
      tx.query("UPDATE property_facts SET fact_value = '29 min' WHERE fact_id = $1", [
        held.factId,
      ]),
    );
    const afterApp = await factRow(held.factId);
    expect(afterApp).toMatchObject({ verified: false, verified_by: null, verified_at: null });

    await client.query(
      "UPDATE property_facts SET fact_value = '31 min' WHERE fact_id = $1",
      [victim.factId],
    );
    expect(await factRow(victim.factId)).toMatchObject({
      verified: false,
      verified_by: null,
      verified_at: null,
    });

    // 7. the function itself demands a tenant context and the session's actor
    await expect(
      client.query("SELECT verify_property_fact($1, $2)", [spare.factId, actorA.userId]),
    ).rejects.toThrow(/tenant context/);
    await expect(
      asStaff(tenantA, actorA, (tx) =>
        tx.query("SELECT verify_property_fact($1, $2)", [spare.factId, actorB.userId]),
      ),
    ).rejects.toThrow(/is not the session user/);

    // none of the probes wrote an audit row
    expect(await auditCount(tenantA.propertyId, "fact.verified")).toBe(audited);
    expect((await factRow(spare.factId)).verified).toBe(false);
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

  it("an update that changes the value resets verification, and lookup answers nothing again", async () => {
    const websiteId = factIdOf(poolWebsite.factId);
    const before = await asApp(demo, (tx) => getFact(tx, demo, websiteId));
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

    expect(await auditActions(DEMO_PROPERTY_ID)).toEqual(
      expect.arrayContaining(["fact.updated", "fact.verified"]),
    );
  });

  it("the lookup path really uses the partial verified index (EXPLAIN)", async () => {
    const plan = await asApp(demo, async (tx) => {
      await tx.query("SET LOCAL enable_seqscan = off");
      const result = await tx.query<{ "QUERY PLAN": string }>(
        `EXPLAIN
         SELECT fact_value, unit, to_char(effective_from, 'YYYY-MM-DD')
           FROM property_facts
          WHERE org_id = '${DEMO_ORG_ID}'
            AND property_id = '${DEMO_PROPERTY_ID}'
            AND topic_key = 'pool.hours'
            AND fact_key = 'closing_time'
            AND language = 'es'
            AND verified
            AND effective_from <= DATE '2026-10-25'
          ORDER BY effective_from DESC, created_at DESC
          LIMIT 1`,
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("property_facts_lookup");
    expect(plan).toMatch(/Index (Only )?Scan/);
  });

  it("creates, reads back and audits a fact with its source version (AC-6)", async () => {
    const createdBefore = await auditCount(tenantA.propertyId, "fact.created");
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
    expect(actions).toContain("fact.created");
    expect(await auditCount(tenantA.propertyId, "fact.created")).toBe(createdBefore + 1);
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

  it("keeps the citation when the field is omitted and clears it only on null (P2)", async () => {
    const created = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "citation_probe", sourceArticleVersionId: versionA })),
    );

    const kept = await asApp(tenantA, (tx) =>
      updateFact(tx, tenantA, actorA, created.factId, {
        topicKey: "spa.services",
        factKey: "citation_probe",
        value: "45 min",
        unit: "duration",
        language: "en",
        effectiveFrom: "2026-03-01",
      }),
    );
    expect(kept.verifiedReset).toBe(false);
    expect(
      (await asApp(tenantA, (tx) => getFact(tx, tenantA, created.factId))).sourceArticleVersionId,
    ).toBe(versionA);

    const cleared = await asApp(tenantA, (tx) =>
      updateFact(tx, tenantA, actorA, created.factId, {
        topicKey: "spa.services",
        factKey: "citation_probe",
        value: "45 min",
        unit: "duration",
        language: "en",
        effectiveFrom: "2026-03-01",
        sourceArticleVersionId: null,
      }),
    );
    expect(cleared.verifiedReset).toBe(false);
    expect(
      (await asApp(tenantA, (tx) => getFact(tx, tenantA, created.factId))).sourceArticleVersionId,
    ).toBeNull();
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

  it("binds every write to the session: no session, a different actor, a foreign member (P2)", async () => {
    const created = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "session_probe" })),
    );

    await expect(
      asStaff(tenantA, null, (tx) =>
        createFact(tx, tenantA, actorA, input({ factKey: "session_probe" })),
      ),
    ).rejects.toThrow(/app\.current_user_id is not set/);

    // syntax failures still refuse first
    await expect(
      asStaff(tenantA, actorA, (tx) =>
        verifyFact(tx, tenantA, undefined as never, created.factId),
      ),
    ).rejects.toBeInstanceOf(FactActorError);
    await expect(
      asStaff(tenantA, actorA, (tx) =>
        verifyFact(tx, tenantA, { userId: "not-a-uuid" }, created.factId),
      ),
    ).rejects.toBeInstanceOf(FactActorError);
    await expect(
      asStaff(tenantA, actorA, (tx) =>
        verifyFact(tx, tenantA, { userId: crypto.randomUUID() }, created.factId),
      ),
    ).rejects.toBeInstanceOf(FactActorError);

    // a well-formed id that is simply not who is logged in
    await expect(
      asApp(tenantA, (tx) => verifyFact(tx, tenantA, actorB, created.factId)),
    ).rejects.toThrow(/is not the session user/);

    // a session whose user has no membership in this property
    await expect(
      asStaff(tenantA, actorB, (tx) => verifyFact(tx, tenantA, actorB, created.factId)),
    ).rejects.toThrow(/is not a member of this property/);

    expect((await factRow(created.factId)).verified).toBe(false);
  });

  it("re-verifying the same fact changes nothing: same stamp, no second audit row", async () => {
    const created = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, input({ factKey: "steam_room" })),
    );
    await asApp(tenantA, (tx) => verifyFact(tx, tenantA, actorA, created.factId));

    const stamped = await factRow(created.factId);
    const audited = await auditCount(tenantA.propertyId, "fact.verified");

    const again = await asApp(tenantA, (tx) =>
      verifyFact(tx, tenantA, actorA, created.factId),
    );
    expect(again).toEqual({ factId: created.factId });

    const after = await factRow(created.factId);
    expect(after.verified).toBe(true);
    expect(after.verified_by).toBe(actorA.userId);
    expect(after.verified_at).toEqual(stamped.verified_at);
    expect(await auditCount(tenantA.propertyId, "fact.verified")).toBe(audited);
  });

  it("keeps an untouched verification, then resets it on a content change (AC-6, P2)", async () => {
    const original = input({ factKey: "updates_reset" });
    const created = await asApp(tenantA, (tx) =>
      createFact(tx, tenantA, actorA, original),
    );
    await asApp(tenantA, (tx) => verifyFact(tx, tenantA, actorA, created.factId));
    const stamped = await factRow(created.factId);
    expect(stamped.verified).toBe(true);

    // 1. THE case the item's contract turns on, asserted on a VERIFIED row:
    //    an update that changes nothing is a no-op, not a reset and not a
    //    trigger exception (review round 3: this half used to run only after
    //    the content change below had already cleared the verdict).
    const same = await asApp(tenantA, (tx) =>
      updateFact(tx, tenantA, actorA, created.factId, original),
    );
    expect(same).toEqual({ factId: created.factId, verifiedReset: false });
    expect(await factRow(created.factId)).toMatchObject({
      verified: true,
      verified_by: actorA.userId,
      verified_at: stamped.verified_at,
      fact_value: original.value,
    });

    // 2. a content change: the trigger drops the verification
    const changed = await asApp(tenantA, (tx) =>
      updateFact(tx, tenantA, actorA, created.factId, {
        ...original,
        value: "35 min",
      }),
    );
    expect(changed).toEqual({ factId: created.factId, verifiedReset: true });
    expect(await factRow(created.factId)).toMatchObject({
      verified: false,
      verified_by: null,
      verified_at: null,
    });

    // 3. nothing material changed again - now on an unverified row
    const again = await asApp(tenantA, (tx) =>
      updateFact(tx, tenantA, actorA, created.factId, {
        ...original,
        value: "35 min",
      }),
    );
    expect(again.verifiedReset).toBe(false);

    const actions = await auditActions(tenantA.propertyId);
    expect(actions.filter((action) => action === "fact.updated").length).toBeGreaterThanOrEqual(3);
    expect(actions).toContain("fact.verified");
  });

  it("re-seeds over a verified fact without touching it (review round 3)", async () => {
    // The demo pool closing time is verified above; `npm run db:seed` is a
    // documented, re-runnable operator command and used to abort here with a
    // raw P0001 from 0009's guard trigger.
    const websiteId = factIdOf(poolWebsite.factId);
    await asApp(demo, (tx) => verifyFact(tx, demo, demoActor, websiteId));
    const stamped = await factRow(websiteId);
    expect(stamped.verified).toBe(true);
    const audited = await auditCount(DEMO_PROPERTY_ID, "fact.verified");

    for (const attempt of [1, 2]) {
      const summary = await seedDemoInTx(client);
      expect(summary.property_facts, `seed ${attempt}`).toBe(FIXTURE_FACTS.length);
      expect((await factRow(websiteId)).verified, `seed ${attempt}`).toBe(true);
      expect(await factRow(websiteId), `seed ${attempt}`).toEqual(stamped);
    }

    // the seed is a no-op for facts: same rows, and no verdict was re-stamped
    const count = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM property_facts WHERE property_id = $1",
      [DEMO_PROPERTY_ID],
    );
    expect(Number(count.rows[0]!.count)).toBe(FIXTURE_FACTS.length);
    expect(await auditCount(DEMO_PROPERTY_ID, "fact.verified")).toBe(audited);
  });

  it("a fact row is rolled back when its audit row cannot be written (AC-6)", async () => {
    const before = await asApp(tenantA, async (tx) => {
      const rows = await tx.query<{ count: string }>(
        "SELECT count(*) AS count FROM property_facts WHERE property_id = $1",
        [tenantA.propertyId],
      );
      return Number(rows.rows[0]!.count);
    });

    await client.query("REVOKE INSERT ON audit_log FROM concierge_app");
    try {
      await expect(
        asApp(tenantA, (tx) =>
          createFact(tx, tenantA, actorA, input({ factKey: "rollback.fact" })),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("GRANT INSERT ON audit_log TO concierge_app");
    }

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
