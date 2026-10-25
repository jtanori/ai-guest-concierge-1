/**
 * S02-02 - property settings under RLS.
 *
 * The store is exercised as the runtime role (`SET LOCAL ROLE concierge_app`)
 * inside a tenant transaction, and the DB CHECKs are probed with direct
 * superuser UPDATEs so a bypassing write is still refused.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../src/db/tenant.ts";
import {
  DEFAULT_SETTINGS,
  parsePropertySettings,
  type PropertySettings,
} from "../../src/settings/schema.ts";
import {
  loadPropertySettings,
  PropertyNotFoundError,
  savePropertySettings,
  type PropertyContext,
} from "../../src/settings/store.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

let client: pg.Client;
let propertyA: PropertyContext;
let propertyB: PropertyContext;

async function asApp<T>(
  context: PropertyContext,
  fn: (tx: pg.Client) => Promise<T>,
): Promise<T> {
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

describe("property settings (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const orgA = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Settings A', 'settings_a') RETURNING org_id",
    );
    const orgB = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Settings B', 'settings_b') RETURNING org_id",
    );
    const a = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Property A', 'property_a') RETURNING property_id",
      [orgA.rows[0]!.org_id],
    );
    const b = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Property B', 'property_b') RETURNING property_id",
      [orgB.rows[0]!.org_id],
    );

    propertyA = { orgId: orgA.rows[0]!.org_id, propertyId: a.rows[0]!.property_id };
    propertyB = { orgId: orgB.rows[0]!.org_id, propertyId: b.rows[0]!.property_id };
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("gives a newly inserted property the full column default", async () => {
    const raw = await asApp(propertyA, async (tx) => {
      const result = await tx.query<{ settings: unknown }>(
        "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'New Property', 'new_property') RETURNING settings",
        [propertyA.orgId],
      );
      return result.rows[0]!.settings;
    });
    expect(parsePropertySettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it("loads the legacy '{}' sentinel as defaults", async () => {
    await client.query("UPDATE properties SET settings = '{}'::jsonb WHERE property_id = $1", [
      propertyB.propertyId,
    ]);
    const loaded = await asApp(propertyB, (tx) => loadPropertySettings(tx, propertyB));
    expect(loaded).toEqual(DEFAULT_SETTINGS);
  });

  it("persists a save, reports changed keys, and re-reads the same value", async () => {
    const patch: Partial<PropertySettings> = {
      tone: "formal",
      retention_days: 30,
    };
    const saved = await asApp(propertyA, (tx) =>
      savePropertySettings(tx, propertyA, patch),
    );
    expect(saved.changed).toEqual(["tone", "retention_days"]);
    expect(saved.settings.tone).toBe("formal");
    expect(saved.settings.retention_days).toBe(30);

    const loaded = await asApp(propertyA, (tx) => loadPropertySettings(tx, propertyA));
    expect(loaded).toEqual(saved.settings);
  });

  it("rejects an invalid direct write with the CHECK constraint", async () => {
    await expect(
      client.query("UPDATE properties SET settings = $1::jsonb WHERE property_id = $2", [
        JSON.stringify({ tone: "shouty" }),
        propertyA.propertyId,
      ]),
    ).rejects.toThrow(/properties_settings_valid/);
  });

  it("mirrors the parser's malformed-value rejections at the CHECK", async () => {
    const base = (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;

    const cases: Array<[string, Record<string, unknown>]> = [];
    const notAnArray = base();
    notAnArray["business_hours"] = "not-an-array";
    cases.push(["business_hours type", notAnArray]);

    const missingTone = base();
    delete missingTone["tone"];
    cases.push(["missing tone", missingTone]);

    const closedWithTimes = base();
    (closedWithTimes["business_hours"] as Array<Record<string, unknown>>)[0] = {
      day: 0,
      closed: true,
      open: "08:00",
      close: "22:00",
    };
    cases.push(["closed day with times", closedWithTimes]);

    const badContact = base();
    badContact["escalation"] = {
      contacts: [{ name: "Desk", channel: "sms", value: "555" }],
    };
    cases.push(["bad contact channel", badContact]);

    const zeroCap = base();
    zeroCap["spend_cap"] = { daily_usd: 0, per_conversation_usd: 0.5 };
    cases.push(["zero cap", zeroCap]);

    const longRetention = base();
    longRetention["retention_days"] = 99999;
    cases.push(["retention out of range", longRetention]);

    for (const [label, value] of cases) {
      await expect(
        client.query("UPDATE properties SET settings = $1::jsonb WHERE property_id = $2", [
          JSON.stringify(value),
          propertyA.propertyId,
        ]),
        label,
      ).rejects.toThrow(/properties_settings_valid/);
    }
  });

  it("rejects after_hours with an all-closed week at the DB CHECK", async () => {
    const closedWeek: PropertySettings = structuredClone(DEFAULT_SETTINGS);
    closedWeek.business_hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: true }));

    await expect(
      client.query(
        "UPDATE properties SET ai_mode = 'after_hours', settings = $1::jsonb WHERE property_id = $2",
        [JSON.stringify(closedWeek), propertyA.propertyId],
      ),
    ).rejects.toThrow(/properties_settings_valid/);
  });

  it("rejects unsupported languages at the DB CHECK", async () => {
    await expect(
      client.query("UPDATE properties SET languages = '{fr}' WHERE property_id = $1", [
        propertyA.propertyId,
      ]),
    ).rejects.toThrow(/properties_languages_supported/);
  });

  it("cannot read or write another property's settings", async () => {
    await expect(
      asApp(propertyA, (tx) => loadPropertySettings(tx, propertyB)),
    ).rejects.toThrow(PropertyNotFoundError);

    await expect(
      asApp(propertyA, (tx) => savePropertySettings(tx, propertyB, { tone: "concise" })),
    ).rejects.toThrow(PropertyNotFoundError);
  });
});
