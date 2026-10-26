/**
 * S07-06 AC-3 — the counters, proven through the real pipeline.
 *
 * `tests/metrics/counters.test.ts` proves the registry. This file proves the
 * **wiring**: that a contract violation, a fallback and an outage actually move
 * the counter, with the tenant labels a dashboard needs. A counter that is only
 * ever incremented by its own test is a counter nobody can alert on.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider, createScriptedProvider } from "../../src/ai/stub.ts";
import {
  counterTotal,
  counterValue,
  resetCounters,
} from "../../src/metrics/counters.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { postGuestMessage, type GuestDeps } from "../../src/guest/service.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const SECRET = "m".repeat(40);
const SLUG = "metrics-hotel";
const BODY = "El desayuno se sirve de 7:00 a 10:30 en el restaurante, todos los días.";

let client: pg.Client;
let tenant: TenantContext;
let propertyId: string;
let versionId: string;

function validAnswer(): Record<string, unknown> {
  return {
    decision: "answer",
    answer: "El desayuno se sirve de 7:00 a 10:30 en el restaurante.",
    language: "es-MX",
    citations: [{ article_version_id: versionId, quote: "se sirve de 7:00 a 10:30" }],
    reason_code: null,
    topic_keys_used: ["breakfast.hours"],
    confidence: 0.9,
  };
}

/** A model answer that breaks the contract: no decision, no citations. */
const BROKEN = { answer: "sí", confidence: "muy alta" };

function deps(ai: GuestDeps["ai"]): GuestDeps {
  return { ai, cookieSecret: SECRET, now: () => new Date("2026-10-25T17:00:00Z") };
}

describe("metrics wiring (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    const seeded = await seedTenant(client, "metrics");
    tenant = { orgId: seeded.orgId, propertyId: seeded.propertyId };
    propertyId = seeded.propertyId;
    await client.query(
      "UPDATE properties SET slug = $2, settings = $3::jsonb WHERE property_id = $1",
      [propertyId, SLUG, JSON.stringify(DEFAULT_SETTINGS)],
    );

    await withTenant(client, tenant, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      const created = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'breakfast.hours', 'Desayuno', 'es') RETURNING article_id`,
        [tenant.orgId, propertyId],
      );
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, $4, $5::vector)
         RETURNING article_version_id`,
        [tenant.orgId, propertyId, created.rows[0]!.article_id, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
      versionId = version.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [versionId]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [tenant.orgId, propertyId, versionId, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
    });
  });

  beforeEach(() => {
    resetCounters();
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("counts a parse failure, labelled by tenant and model", async () => {
    const ai = withResilience(
      createFixedProvider(BROKEN, "stub-primary-2026-01-01"),
      createFixedProvider(BROKEN, "stub-fallback-2026-01-01"),
      { retries: 0, sleep: async () => {}, now: () => 0 },
    );
    const turn = await postGuestMessage(deps(ai), client, {
      slug: SLUG,
      text: "¿A qué hora es el desayuno?",
    });

    // The guest gets the honest acknowledgement, not an answer.
    expect(turn.decision).toBe("escalate");
    expect(turn.reasonCode).toBe("policy_block");

    expect(counterTotal("ai_parse_failure_total")).toBe(1);
    expect(
      counterValue("ai_parse_failure_total", {
        org_id: tenant.orgId,
        property_id: propertyId,
        model: "stub-primary-2026-01-01",
      }),
    ).toBe(1);
    // And never guest text, whatever else happens.
    expect(counterTotal("ai_fallback_total")).toBe(0);
  });

  it("counts a fallback, because the guest never notices and nothing else would say so", async () => {
    // Primary fails with a RETRYABLE error (500), fallback answers.
    const ai = withResilience(
      createScriptedProvider([new Error("primary exploded")], "stub-primary-2026-01-01"),
      createFixedProvider(validAnswer(), "stub-fallback-2026-01-01"),
      { retries: 0, sleep: async () => {}, now: () => 0 },
    );
    const turn = await postGuestMessage(deps(ai), client, {
      slug: SLUG,
      text: "¿A qué hora es el desayuno?",
    });

    expect(turn.decision).toBe("answer");
    expect(counterTotal("ai_fallback_total")).toBe(1);
    expect(
      counterValue("ai_fallback_total", {
        org_id: tenant.orgId,
        property_id: propertyId,
        model: "stub-fallback-2026-01-01",
      }),
    ).toBe(1);
    // A fallback is not an outage, and the two must not be confused in an alert.
    expect(counterTotal("ai_outage_total")).toBe(0);
  });

  it("counts an outage once, alongside S07-05's evidence", async () => {
    const ai = withResilience(
      createScriptedProvider([new Error("primary down")], "stub-primary-2026-01-01"),
      createScriptedProvider([new Error("fallback down")], "stub-fallback-2026-01-01"),
      { retries: 0, sleep: async () => {}, now: () => 0 },
    );
    const turn = await postGuestMessage(deps(ai), client, {
      slug: SLUG,
      text: "¿A qué hora es el desayuno?",
    });
    expect(turn.decision).toBe("unavailable");
    expect(counterTotal("ai_outage_total")).toBe(1);
    // Series are an exact label set — asking with fewer labels is a different
    // series, which is what keeps a per-tenant query honest.
    expect(counterValue("ai_outage_total", { org_id: tenant.orgId, property_id: propertyId })).toBe(1);
    expect(counterValue("ai_outage_total", { property_id: propertyId })).toBe(0);
    expect(counterTotal("ai_parse_failure_total")).toBe(0);
  });
});
