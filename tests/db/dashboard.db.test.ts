/**
 * S10-03 — the dashboard reads `rollups` and computes nothing.
 *
 * These cases are written against independently inserted `rollups` rows, never
 * against `runRollups` output: if the dashboard and the rollup shared a bug, a
 * round-trip test would agree with itself and pass. Inserting `0.5714` by hand and
 * requiring the screen to hand back `0.5714` is the check AC-2 actually asks for.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DashboardRangeError,
  getDashboard,
  type Dashboard,
} from "../../src/analytics/dashboard.ts";
import { requireRole } from "../../src/auth/guard.ts";
import type { StaffSession } from "../../src/auth/context.ts";
import { RoleNotOnSurfaceError, type Role } from "../../src/auth/guard.ts";
import type { TenantContext } from "../../src/db/tenant.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

let client: pg.Client;
let tenantA: TenantContext;
let tenantB: TenantContext;
const USER = "33333333-3333-5333-a333-333333333333";

function sessionFor(role: Role): StaffSession {
  return { userUuid: USER, role, requireRole: (surface, mode) => requireRole(role, surface, mode) };
}

async function putRollup(
  context: TenantContext,
  metric: string,
  windowStart: string,
  value: string,
): Promise<void> {
  await client.query(
    `INSERT INTO rollups (org_id, property_id, metric, granularity, window_start, value)
     VALUES ($1, $2, $3, 'daily', $4::date, $5::numeric)
     ON CONFLICT (property_id, metric, window_start, granularity)
     DO UPDATE SET value = EXCLUDED.value, generated_at = now()`,
    [context.orgId, context.propertyId, metric, windowStart, value],
  );
}

function tileOf(dashboard: Dashboard, metric: string) {
  const tile = dashboard.tiles.find((candidate) => candidate.metric === metric);
  expect(tile, metric).toBeDefined();
  return tile!;
}

describe("management dashboard (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const a = await seedTenant(client, "dash_a");
    tenantA = { orgId: a.orgId, propertyId: a.propertyId };
    await client.query("UPDATE properties SET time_zone = $2 WHERE property_id = $1", [
      tenantA.propertyId,
      "America/Hermosillo",
    ]);

    const b = await seedTenant(client, "dash_b");
    tenantB = { orgId: b.orgId, propertyId: b.propertyId };

    // Property A: two stored days, one percentile gap on purpose.
    await putRollup(tenantA, "conversations_started", "2026-10-24", "4");
    await putRollup(tenantA, "conversations_started", "2026-10-25", "7");
    await putRollup(tenantA, "messages_received", "2026-10-25", "23");
    await putRollup(tenantA, "containment", "2026-10-25", "0.5714");
    await putRollup(tenantA, "first_response_p95_seconds", "2026-10-25", "4.250");

    // Property B: a different number on the same day, to catch a mixed-up key.
    await putRollup(tenantB, "conversations_started", "2026-10-25", "99");
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("AC-2: every tile hands back the stored value, verbatim", async () => {
    const dashboard = await getDashboard(client, tenantA, sessionFor("owner"), {
      from: "2026-10-24",
      to: "2026-10-25",
    });

    expect(tileOf(dashboard, "conversations_started").latest).toEqual({
      windowStart: "2026-10-25",
      value: "7",
    });
    expect(tileOf(dashboard, "messages_received").latest?.value).toBe("23");
    // The ratio is NOT re-derived: 0.5714 goes out as 0.5714, not as 57%.
    expect(tileOf(dashboard, "containment").latest?.value).toBe("0.5714");
    expect(tileOf(dashboard, "first_response_p95_seconds").latest?.value).toBe("4.250");

    // Every day the dashboard returned exists in the table, as text.
    const stored = await client.query<{ metric: string; window_start: string; value: string }>(
      `SELECT metric, window_start::text, value::text FROM rollups WHERE property_id = $1`,
      [tenantA.propertyId],
    );
    const storedSet = new Set(stored.rows.map((row) => `${row.metric}|${row.window_start}|${row.value}`));
    for (const tile of dashboard.tiles) {
      for (const day of tile.days) {
        expect(storedSet.has(`${tile.metric}|${day.windowStart}|${day.value}`), tile.metric).toBe(
          true,
        );
      }
    }
  });

  it("never fills a missing day with zero", async () => {
    const dashboard = await getDashboard(client, tenantA, sessionFor("manager"), {
      from: "2026-10-24",
      to: "2026-10-25",
    });

    // conversations_started has both days; messages_received only the 25th.
    expect(tileOf(dashboard, "conversations_started").days.map((day) => day.windowStart)).toEqual([
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(tileOf(dashboard, "messages_received").days.map((day) => day.windowStart)).toEqual([
      "2026-10-25",
    ]);
    // A tile with nothing in the range is null, not zero — the same rule S10-02 uses
    // for a percentile day, applied one layer up.
    expect(tileOf(dashboard, "ack_median_seconds").latest).toBeNull();
    expect(tileOf(dashboard, "ack_median_seconds").days).toEqual([]);
  });

  it("excludes another property's rows entirely", async () => {
    const dashboard = await getDashboard(client, tenantA, sessionFor("front_desk"), {
      from: "2026-10-25",
      to: "2026-10-25",
    });
    expect(tileOf(dashboard, "conversations_started").latest?.value).toBe("7");
    const values = dashboard.tiles.flatMap((tile) => tile.days.map((day) => day.value));
    expect(values).not.toContain("99");
  });

  it("defaults the range to the last seven days in the property's zone", async () => {
    const dashboard = await getDashboard(client, tenantA, sessionFor("observer"));
    const expected = await client.query<{ today: string; week_ago: string }>(
      `SELECT (now() AT TIME ZONE $1)::date::text AS today,
              ((now() AT TIME ZONE $1)::date - 6)::text AS week_ago`,
      ["America/Hermosillo"],
    );
    expect(dashboard.to).toBe(expected.rows[0]!.today);
    expect(dashboard.from).toBe(expected.rows[0]!.week_ago);
    expect(dashboard.timeZone).toBe("America/Hermosillo");
  });

  it("refuses a range the rollup would refuse", async () => {
    await expect(
      getDashboard(client, tenantA, sessionFor("owner"), { from: "2026-10-25", to: "2026-10-01" }),
    ).rejects.toBeInstanceOf(DashboardRangeError);
    await expect(
      getDashboard(client, tenantA, sessionFor("owner"), { from: "2026-10-25" }),
    ).rejects.toBeInstanceOf(DashboardRangeError);
  });

  it("checks the role before reading anything", async () => {
    const denied: StaffSession = {
      userUuid: USER,
      role: "observer",
      requireRole: () => {
        throw new RoleNotOnSurfaceError("observer", "analytics", "read");
      },
    };
    await expect(getDashboard(client, tenantA, denied)).rejects.toBeInstanceOf(
      RoleNotOnSurfaceError,
    );
  });

  it("AC-1: every tile names its metric and the statement that produced it", async () => {
    const dashboard = await getDashboard(client, tenantA, sessionFor("owner"));
    for (const tile of dashboard.tiles) {
      expect(tile.metric.length).toBeGreaterThan(0);
      expect(tile.querySql).toContain("FROM");
      // The statement a manager reads must be the one that reads this metric's row,
      // so the metric name is discoverable in it or it is a count of an event type.
      expect(tile.querySql).toMatch(/\$\d/);
    }
  });
});
