/**
 * S10-03 — the management dashboard's read side.
 *
 * AC-2 is "numbers match `rollups` exactly (no client-side recomputation)", and the
 * only way to make that true rather than aspirational is to have **no arithmetic
 * anywhere on the path**. This module reads stored rows, groups them by metric in a
 * fixed order, and hands out the value *as the text Postgres returned it*. It never
 * sums a range, never averages two days, never divides one metric by another. The
 * web screen formats (a ratio becomes "57.1%") and does nothing else.
 *
 * That has one visible consequence worth stating: the dashboard shows a **day**,
 * not a "last 7 days total". A total is a computed number, and the moment the
 * screen computes one, the tile is no longer traceable to `SELECT value FROM
 * rollups`. A range therefore means "the stored days between these dates", each
 * tile shows the most recent one, and the earlier ones are listed underneath. If
 * somebody wants a weekly total, it belongs in the rollup layer as its own metric —
 * computed once, stored, and reconciled like everything else.
 *
 * A day with no row renders as *no data*, not as zero: S10-02 deliberately writes
 * no row for a percentile day with no answers, and filling that in here would
 * resurrect the "instant first response" lie one layer up.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import type { StaffSession } from "../auth/context.ts";
import type { StringId } from "../i18n/catalog.ts";
import { TILES } from "./tiles.ts";
import { validateRange, type RollupUnit } from "./rollups.ts";

/** A stored `rollups` row, value left as the exact text Postgres produced. */
export interface DashboardDay {
  windowStart: string;
  value: string;
}

export interface DashboardTile {
  id: string;
  /** `rollups.metric` — AC-1's "links to its metric name". */
  metric: string;
  labelId: StringId;
  descriptionId: StringId;
  unit: RollupUnit;
  /** AC-1's "the SQL that produced it" — the registry's own statement. */
  querySql: string;
  /** Stored days only, oldest first. No zero filling. */
  days: DashboardDay[];
  /** The most recent stored day, or null when there is nothing. */
  latest: DashboardDay | null;
}

export interface Dashboard {
  from: string;
  to: string;
  /** The property's zone — the days above are its days. */
  timeZone: string;
  /** `max(generated_at)` in the window, so the reader knows how fresh this is. */
  generatedAt: string | null;
  tiles: DashboardTile[];
}

export class DashboardRangeError extends Error {}
export class DashboardPropertyNotFoundError extends Error {}

export interface DashboardOptions {
  from?: string | null;
  to?: string | null;
}

const DEFAULT_DAYS = 7;

/**
 * Read the dashboard for one property.
 *
 * The role check is the first statement, as everywhere else on a staff surface:
 * `analytics` is read-only for all four roles (S02-01's matrix), and a caller that
 * the matrix excludes gets a 403 before a single row is read.
 */
export async function getDashboard(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  options: DashboardOptions = {},
): Promise<Dashboard> {
  session.requireRole("analytics", "read");
  assertTenantShape(context);

  const hasFrom = options.from !== undefined && options.from !== null;
  const hasTo = options.to !== undefined && options.to !== null;
  if (hasFrom !== hasTo) {
    throw new DashboardRangeError("from and to go together");
  }

  const zone = await client.query<{ time_zone: string; today: string; week_ago: string }>(
    `SELECT time_zone,
            (now() AT TIME ZONE time_zone)::date::text AS today,
            ((now() AT TIME ZONE time_zone)::date - $3::int)::text AS week_ago
       FROM properties
      WHERE org_id = $1 AND property_id = $2`,
    [context.orgId, context.propertyId, DEFAULT_DAYS - 1],
  );
  const row = zone.rows[0];
  if (row === undefined) {
    // The session's membership already proved this property is reachable, so this
    // is "the property row is gone", not "you may not see it" — and it is a 404,
    // never a 403 that would confirm an id.
    throw new DashboardPropertyNotFoundError("property not found for this session");
  }

  let from = row.week_ago;
  let to = row.today;
  if (hasFrom && hasTo) {
    // One validator, shared with `npm run rollup`: a dashboard that accepts a date
    // the rollup would refuse is a screen that queries a range nobody can compute.
    try {
      ({ from, to } = validateRange({ from: String(options.from), to: String(options.to) }));
    } catch (error) {
      throw new DashboardRangeError((error as Error).message);
    }
  }

  const stored = await client.query<{
    metric: string;
    window_start: string;
    value: string;
    generated_at: Date | null;
  }>(
    `SELECT metric,
            window_start::text AS window_start,
            value::text AS value,
            generated_at
       FROM rollups
      WHERE org_id = $1 AND property_id = $2 AND granularity = 'daily'
        AND window_start BETWEEN $3::date AND $4::date
      ORDER BY metric, window_start`,
    [context.orgId, context.propertyId, from, to],
  );

  const byMetric = new Map<string, DashboardDay[]>();
  let generatedAt: string | null = null;
  for (const storedRow of stored.rows) {
    // `window_start::text` and `value::text` on purpose: a `date` arrives as a JS
    // Date at midnight (which shifts a day in negative offsets) and a `numeric`
    // arrives as a string anyway. Text is the only lossless route from the column
    // to the screen, and it is what makes AC-2 checkable.
    const days = byMetric.get(storedRow.metric) ?? [];
    days.push({ windowStart: storedRow.window_start, value: storedRow.value });
    byMetric.set(storedRow.metric, days);

    const stamp = storedRow.generated_at;
    if (stamp !== null) {
      const iso = stamp.toISOString();
      if (generatedAt === null || iso > generatedAt) generatedAt = iso;
    }
  }

  return {
    from,
    to,
    timeZone: row.time_zone,
    generatedAt,
    tiles: TILES.map((tile) => {
      const days = byMetric.get(tile.metric) ?? [];
      return {
        id: tile.id,
        metric: tile.metric,
        labelId: tile.labelId,
        descriptionId: tile.descriptionId,
        unit: tile.unit,
        querySql: tile.querySql,
        days,
        latest: days.length === 0 ? null : days[days.length - 1]!,
      };
    }),
  };
}
