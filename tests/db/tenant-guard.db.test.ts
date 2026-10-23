/**
 * S01-02 — the application-layer guard half of D1.
 *
 * withTenant() is the ONLY sanctioned way for app code to touch tenant rows:
 * it refuses empty/invalid contexts, scopes the context to a transaction
 * (SET LOCAL semantics), and never leaves context behind after COMMIT —
 * the SQL-level isolation properties are proven in isolation.db.test.ts.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContextError, withTenant } from "../../src/db/tenant.ts";
import { dropScratch, recreateScratch, scratchUrl } from "./helpers.db.ts";

describe("withTenant (db)", () => {
  let client: pg.Client;
  let orgId = "", propertyId = "";

  beforeAll(async () => {
    await recreateScratch();
    client = new pg.Client({ connectionString: scratchUrl() });
    await client.connect();
    const org = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('guard org', 'guard_org') RETURNING org_id",
    );
    orgId = org.rows[0]!.org_id;
    const prop = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'guard prop', 'guard_prop') RETURNING property_id",
      [orgId],
    );
    propertyId = prop.rows[0]!.property_id;
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("scopes context inside the transaction and reads tenant rows", async () => {
    const result = await withTenant(client, { orgId, propertyId }, async (tx) => {
      const set = await tx.query(
        "SELECT current_setting('app.current_org_id', true) AS org",
      );
      expect(set.rows[0]!.org).toBe(orgId);
      return "ok";
    });
    expect(result).toBe("ok");
  });

  it("leaves no context behind after COMMIT (SET LOCAL semantics)", async () => {
    await withTenant(client, { orgId, propertyId }, async () => {
      // callback is a no-op — the assertion is the state after commit
    });
    const after = await client.query("SELECT current_setting('app.current_org_id', true) AS org");
    expect(after.rows[0]!.org).toBe(""); // gone once the transaction ended
  });

  it("rolls tenant work back when the callback throws", async () => {
    await expect(
      withTenant(client, { orgId, propertyId }, async (tx) => {
        await tx.query(
          `INSERT INTO channel_connections (org_id, property_id, channel)
           VALUES ($1, $2, 'web')`,
          [orgId, propertyId],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    const count = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM channel_connections",
    );
    expect(count.rows[0]!.n).toBe("0");
  });

  it("refuses empty and malformed tenant context", async () => {
    await expect(
      withTenant(client, { orgId: "", propertyId: propertyId }, async () => undefined),
    ).rejects.toThrow(TenantContextError);
    await expect(
      withTenant(client, { orgId: "not-a-uuid", propertyId: propertyId }, async () => undefined),
    ).rejects.toThrow(/orgId must be a uuid/);
    await expect(
      withTenant(client, { orgId, propertyId: "" }, async () => undefined),
    ).rejects.toThrow(/propertyId is required/);
  });
});
