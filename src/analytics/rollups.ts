/**
 * S10-02 — daily rollups: SQL over `events`, recomputable for any past date.
 *
 * The acceptance criterion is "a historical date can be recomputed without drift",
 * and the only way to keep that promise is to make the computation a pure function
 * of the rows that exist *now*. There is no second pipeline, no stream, no
 * incremental counter that could disagree with a recount: every metric below is a
 * statement over the product's own tables, and re-running it is how you find out
 * whether yesterday's number was right.
 *
 * ## Why the metric SQL lives here, as text, and is exported
 *
 * S10-03's acceptance criterion is that **every dashboard tile is traceable to the
 * query a manager can explain**. A tile that formats a number the dashboard
 * computed itself is a number nobody can audit, and a tile that re-implements the
 * rollup's query drifts from it at the first edit. So each metric owns exactly one
 * statement, exported as a constant, and S10-03 renders that same string in its
 * "show query" disclosure. The upsert below and the tile's evidence are literally
 * the same text — see `TILE_SQL` in `tiles.ts`.
 *
 * ## Tenant and time zone
 *
 * Two things every statement gets right, because both have already gone wrong
 * once in this repo:
 *
 *  - **Both tenant columns are written.** `rollups` is FORCE-RLS, its unique key
 *    is per property, and its `(org_id, property_id)` pair is an FK to
 *    `properties`. Grouping by `property_id` alone would eventually write a row
 *    under the wrong org and the FK would refuse it — after the fact, at 02:00.
 *  - **Days are the property's days, not UTC's.** `created_at` is timestamptz and
 *    every boundary here is `((created_at AT TIME ZONE p.time_zone)::date)`, the
 *    same idiom 0020 fixed after S03-03 shipped `CURRENT_DATE` on a property whose
 *    guests are seven hours behind the server. A rollup that disagrees with the
 *    property's own business hours is not a rounding error; it is a different day.
 *
 * ## Zero is a fact; a p95 of zero is a fabrication
 *
 * Count metrics join against a `generate_series` of days, so a day with no events
 * rolls up to an explicit `0`. That is what a manager wants to see, and it is
 * exactly what `SELECT count(*) … WHERE date = d` returns (AC-2).
 *
 * The two percentile metrics deliberately do **not** do that: a day with no
 * answered conversations has no p95, and writing `0` would render as "instant
 * first response" on the dashboard — the most flattering possible lie. Those
 * metrics return no row for an empty day (`omitEmptyDays`), and the tile shows
 * "no data". Their stale rows inside the recomputed window are deleted first,
 * because a p95 that outlives the rows that produced it is the drift this item
 * exists to prevent.
 *
 * ## What this module does not do
 *
 * `reconcile()` (S10-01) is not called here. The rollup is a *definition* of each
 * metric over `events`; reconciliation is the separate check that the business
 * tables and `events` agree about how many rows exist. Wiring them together would
 * make a rollup fail whenever an unrelated pair drifted, and the two answers are
 * more useful apart. The windowed reconciliation is safe to build on since #147 /
 * `src/events/clock.ts` gave every producer and its event one identical timestamp.
 */
import type pg from "pg";
import { withTenant, type TenantContext } from "../db/tenant.ts";

/** What the stored `value` means, so a formatter never has to guess. */
export type RollupUnit = "count" | "ratio" | "seconds";

/**
 * The metric names as a union, not `string`.
 *
 * S10-03's tile table is `Record<RollupMetricName, …>`, so adding a metric here
 * without a tile (or a tile for a metric that does not exist) is a **compile error**
 * rather than a dashboard tile that renders a catalogue id nobody wrote.
 */
export type RollupMetricName =
  | "conversations_started"
  | "messages_received"
  | "ai_answers_sent"
  | "escalations"
  | "no_answers"
  | "containment"
  | "first_response_p95_seconds"
  | "requests_created"
  | "requests_acknowledged"
  | "ack_median_seconds"
  | "knowledge_gaps_opened"
  | "knowledge_gaps_closed";

export interface RollupMetric {
  /** `rollups.metric` — stable, used by tiles and by the runbook. */
  metric: RollupMetricName;
  unit: RollupUnit;
  /** Where the number comes from. Events win where a count is available. */
  source: "events" | "conversations" | "messages" | "service_requests";
  /** One sentence a manager can repeat without reading the SQL. */
  describes: string;
  /**
   * True when an empty day must have no row at all. Only the percentile metrics
   * set it; see the header.
   */
  omitEmptyDays: boolean;
  /**
   * The statement. Parameters, in order: `$1` org_id, `$2` property_id,
   * `$3` from (date), `$4` to (date). Returns
   * `(org_id, property_id, window_start date, value numeric)`.
   */
  sql: string;
}

/**
 * The day series. A LEFT JOIN against it is what turns "no rows" into `0`, which
 * is the difference between a total and a gap.
 */
const DAYS = `days AS (
  SELECT g::date AS window_start
  FROM generate_series($3::date, $4::date, interval '1 day') AS g
)`;

/** The property's zone, read from the row that owns it. */
const ZONE = `zone AS (
  SELECT time_zone FROM properties WHERE org_id = $1 AND property_id = $2
)`;

/**
 * A count of one event type per property-local day.
 *
 * The predicate is `(created_at AT TIME ZONE z.time_zone)::date BETWEEN …`, which
 * is not index-friendly on its own; the `(property_id, event_type, created_at)`
 * index still narrows the scan by its first two columns, and a per-property daily
 * window is small enough that a full index scan over one property/type is the
 * honest cost of getting the day boundary right.
 */
function eventCount(eventType: string): string {
  return `
WITH ${DAYS},
${ZONE},
counts AS (
  SELECT (e.created_at AT TIME ZONE z.time_zone)::date AS window_start,
         count(*)::numeric AS value
  FROM events e CROSS JOIN zone z
  WHERE e.org_id = $1 AND e.property_id = $2
    AND e.event_type = '${eventType}'
    AND (e.created_at AT TIME ZONE z.time_zone)::date BETWEEN $3::date AND $4::date
  GROUP BY 1
)
SELECT $1::uuid AS org_id, $2::uuid AS property_id,
       d.window_start, COALESCE(c.value, 0)::numeric AS value
FROM days d LEFT JOIN counts c USING (window_start)
ORDER BY d.window_start`;
}

/**
 * Containment: of the conversations *started* that day, how many never needed a
 * staff message.
 *
 * Stored as a ratio (0..1, four decimals) rather than a count, because Appendix D
 * states the target as a percentage (≥55%) and the dashboard is not allowed to
 * derive numbers in JS. The denominator is `conversations_started`, stored under
 * its own metric from `events`, so the ratio can be checked against it — and the
 * statement divides explicitly rather than trusting that the two agree.
 *
 * "Never needed a staff message" is evaluated over the conversation's whole life,
 * not just that day: a thread that escalates on Thursday was not contained on
 * Wednesday. A conversation that is still open and might yet escalate counts as
 * contained *so far*, which is why the number is only meaningful over days old
 * enough to have settled — the nightly recompute of the last three days exists for
 * precisely that reason.
 */
const CONTAINMENT_SQL = `
WITH ${DAYS},
${ZONE},
counts AS (
  SELECT (conv.created_at AT TIME ZONE z.time_zone)::date AS window_start,
         count(*) AS started,
         count(*) FILTER (
           WHERE NOT EXISTS (
             SELECT 1 FROM events s
             WHERE s.org_id = conv.org_id AND s.property_id = conv.property_id
               AND s.conversation_id = conv.conversation_id
               AND s.event_type = 'staff_message_sent'
           )
         ) AS contained
  FROM conversations conv CROSS JOIN zone z
  WHERE conv.org_id = $1 AND conv.property_id = $2
    AND (conv.created_at AT TIME ZONE z.time_zone)::date BETWEEN $3::date AND $4::date
  GROUP BY 1
)
SELECT $1::uuid AS org_id, $2::uuid AS property_id,
       d.window_start,
       CASE WHEN c.started IS NULL OR c.started = 0 THEN 0::numeric
            ELSE round(c.contained::numeric / c.started::numeric, 4) END AS value
FROM days d LEFT JOIN counts c USING (window_start)
ORDER BY d.window_start`;

/**
 * First response p95, in seconds: per conversation, from its first inbound guest
 * message to the first outbound message of any author.
 *
 * The pair is conversation-level on purpose. Appendix D's two targets ("≤5s AI /
 * ≤10 min human") are about how long a guest waited for *anything*, and a
 * per-message latency would average in every follow-up in a long thread, which is
 * not what anyone is promising. Attribution is the day of the *question*, not the
 * answer: a guest who wrote at 23:58 and was answered at 00:04 waited, and the
 * wait belongs to the day it started.
 *
 * A conversation whose answer never came has no first-response time and is
 * excluded — an unanswered thread is a `no_answer`, which is its own metric. A
 * conversation that is still open has no row yet, and will get one on the next
 * recompute of that day.
 */
const FIRST_RESPONSE_SQL = `
WITH ${ZONE},
per_conversation AS (
  SELECT conv.conversation_id,
         asked.asked_at,
         (SELECT min(o.created_at) FROM messages o
           WHERE o.org_id = $1 AND o.property_id = $2
             AND o.conversation_id = conv.conversation_id
             AND o.direction = 'outbound'
             AND o.created_at >= asked.asked_at) AS answered_at
  FROM conversations conv
  CROSS JOIN zone z
  CROSS JOIN LATERAL (
    SELECT min(m.created_at) AS asked_at
    FROM messages m
    WHERE m.org_id = $1 AND m.property_id = $2
      AND m.conversation_id = conv.conversation_id
      AND m.direction = 'inbound' AND m.author_role = 'guest'
  ) asked
  WHERE conv.org_id = $1 AND conv.property_id = $2
    AND asked.asked_at IS NOT NULL
),
counts AS (
  SELECT (p.asked_at AT TIME ZONE z.time_zone)::date AS window_start,
         percentile_cont(0.95) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (p.answered_at - p.asked_at))
         ) AS value
  FROM per_conversation p CROSS JOIN zone z
  WHERE p.answered_at IS NOT NULL
    AND (p.asked_at AT TIME ZONE z.time_zone)::date BETWEEN $3::date AND $4::date
  GROUP BY 1
)
SELECT $1::uuid AS org_id, $2::uuid AS property_id,
       c.window_start, round(c.value::numeric, 3) AS value
FROM counts c
ORDER BY c.window_start`;

/**
 * Median request acknowledgement, in seconds — the S09 half of Appendix D's
 * "Request acknowledgement ≤10 min median".
 *
 * `service_requests` is the source of truth here, not `request_created` /
 * `request_acknowledged` events: the two timestamps already exist on the row the
 * events describe, and the events would only restate them. This is the one place
 * the charter's "all from events" is followed to the letter — events are where a
 * count lives, and a duration lives on the row.
 *
 * Only acknowledged requests count. An unacknowledged request is not a fast one;
 * it is the failure mode this metric exists to make visible, and it is visible as
 * the gap between `requests_created` and `requests_acknowledged`.
 */
const ACK_MEDIAN_SQL = `
WITH ${ZONE},
counts AS (
  SELECT (r.created_at AT TIME ZONE z.time_zone)::date AS window_start,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (r.acknowledged_at - r.created_at))
         ) AS value
  FROM service_requests r CROSS JOIN zone z
  WHERE r.org_id = $1 AND r.property_id = $2
    AND r.acknowledged_at IS NOT NULL
    AND (r.created_at AT TIME ZONE z.time_zone)::date BETWEEN $3::date AND $4::date
  GROUP BY 1
)
SELECT $1::uuid AS org_id, $2::uuid AS property_id,
       c.window_start, round(c.value::numeric, 3) AS value
FROM counts c
ORDER BY c.window_start`;

/**
 * Every metric, in the order the dashboard shows them: what happened (volume),
 * then how much of it the AI handled (containment), then how fast, then the
 * human queue, then the content loop. A dashboard sorted alphabetically is a
 * list; this is a story about one day.
 */
export const ROLLUP_METRICS: readonly RollupMetric[] = [
  {
    metric: "conversations_started",
    unit: "count",
    source: "events",
    describes: "conversations opened by a guest",
    omitEmptyDays: false,
    sql: eventCount("conversation_started"),
  },
  {
    metric: "messages_received",
    unit: "count",
    source: "events",
    describes: "guest messages received",
    omitEmptyDays: false,
    sql: eventCount("message_received"),
  },
  {
    metric: "ai_answers_sent",
    unit: "count",
    source: "events",
    describes: "answers the assistant sent to a guest",
    omitEmptyDays: false,
    sql: eventCount("ai_answer_sent"),
  },
  {
    metric: "escalations",
    unit: "count",
    source: "events",
    describes: "answers handed to a person",
    omitEmptyDays: false,
    sql: eventCount("ai_escalated"),
  },
  {
    metric: "no_answers",
    unit: "count",
    source: "events",
    describes: "questions the assistant could not answer",
    omitEmptyDays: false,
    sql: eventCount("no_answer_emitted"),
  },
  {
    metric: "containment",
    unit: "ratio",
    source: "conversations",
    describes: "share of conversations that never needed a staff message",
    omitEmptyDays: false,
    sql: CONTAINMENT_SQL,
  },
  {
    metric: "first_response_p95_seconds",
    unit: "seconds",
    source: "messages",
    describes: "p95 wait from a guest's first message to the first reply",
    omitEmptyDays: true,
    sql: FIRST_RESPONSE_SQL,
  },
  {
    metric: "requests_created",
    unit: "count",
    source: "events",
    describes: "service requests opened",
    omitEmptyDays: false,
    sql: eventCount("request_created"),
  },
  {
    metric: "requests_acknowledged",
    unit: "count",
    source: "events",
    describes: "service requests acknowledged by staff",
    omitEmptyDays: false,
    sql: eventCount("request_acknowledged"),
  },
  {
    metric: "ack_median_seconds",
    unit: "seconds",
    source: "service_requests",
    describes: "median minutes from request to acknowledgement",
    omitEmptyDays: true,
    sql: ACK_MEDIAN_SQL,
  },
  {
    metric: "knowledge_gaps_opened",
    unit: "count",
    source: "events",
    describes: "missing answers added to the content queue",
    omitEmptyDays: false,
    sql: eventCount("knowledge_gap_created"),
  },
  {
    metric: "knowledge_gaps_closed",
    unit: "count",
    source: "events",
    describes: "content gaps closed by the team",
    omitEmptyDays: false,
    sql: eventCount("knowledge_gap_closed"),
  },
];

/** The metric names, in dashboard order — the contract S10-03 renders. */
export const ROLLUP_METRIC_NAMES: readonly RollupMetricName[] = ROLLUP_METRICS.map(
  (m) => m.metric,
);

export interface RollupRange {
  /** Inclusive first local day, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive last local day, `YYYY-MM-DD`. */
  to: string;
}

export interface RollupRow {
  metric: RollupMetricName;
  windowStart: string;
  value: number;
}

export interface RollupResult {
  orgId: string;
  propertyId: string;
  range: RollupRange;
  rows: RollupRow[];
  /** Rows upserted. Zero on a dry run, by definition. */
  written: number;
  dryRun: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a range before any SQL runs. A `--date 2026-13-01` that reaches
 * Postgres raises `date/time field value out of range` from inside a transaction
 * mid-loop, which leaves half the metrics written for the property; failing here
 * costs nothing and keeps a bad invocation from being a partial one.
 */
export function validateRange(range: RollupRange): RollupRange {
  for (const [key, value] of [
    ["from", range.from],
    ["to", range.to],
  ] as const) {
    if (!DATE_ONLY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      throw new Error(`rollup: --${key} must be a calendar date (YYYY-MM-DD), got "${value}"`);
    }
  }
  if (range.from > range.to) {
    throw new Error(`rollup: --from ${range.from} is after --to ${range.to}`);
  }
  return range;
}

/** `--date D` is a range of one day; expressing it once keeps the CLI honest. */
export function rangeForDate(date: string): RollupRange {
  return validateRange({ from: date, to: date });
}

/**
 * Recompute `range` for one tenant and upsert the results.
 *
 * One `INSERT … ON CONFLICT` per metric, which is what the unique key
 * `(property_id, metric, window_start, granularity)` exists for: re-running a date
 * rewrites the same rows in place, so `generated_at` moves and the numbers do not.
 * The whole recompute is one transaction — a metric that fails halfway leaves the
 * previous day's numbers intact rather than a property half-updated.
 *
 * Runs as the caller's role under `withTenant`, so on a non-superuser deployment
 * (Neon) the policy `org_id = current_org_id() AND property_id = current_property_id()`
 * is what authorises every write. A caller that passes the wrong tenant writes from
 * a context the policy does not match, and gets zero rows through — not a leak.
 */
export async function runRollups(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  range: RollupRange,
  options: { dryRun?: boolean } = {},
): Promise<RollupResult> {
  const validated = validateRange(range);
  const dryRun = options.dryRun === true;

  return withTenant(client, context, async (scoped) => {
    const rows: RollupRow[] = [];
    let written = 0;

    for (const metric of ROLLUP_METRICS) {
      if (metric.omitEmptyDays && !dryRun) {
        // A percentile that outlives the rows behind it is drift: delete this
        // metric's rows in the window before writing the ones that still exist.
        await scoped.query(
          `DELETE FROM rollups
            WHERE org_id = $1 AND property_id = $2 AND metric = $3
              AND granularity = 'daily'
              AND window_start BETWEEN $4::date AND $5::date`,
          [context.orgId, context.propertyId, metric.metric, validated.from, validated.to],
        );
      }

      const result = await scoped.query<{
        window_start: string | Date;
        value: string;
      }>(metric.sql, [context.orgId, context.propertyId, validated.from, validated.to]);

      if (result.rows.length > 0) {
        for (const row of result.rows) {
          rows.push({
            metric: metric.metric,
            windowStart: normaliseDate(row.window_start),
            value: Number(row.value),
          });
        }

        if (!dryRun) {
          // One statement per metric, not one per row: an upsert loop would take
          // a round trip per day of a backfill for no benefit.
          await scoped.query(
            `INSERT INTO rollups (org_id, property_id, metric, granularity, window_start, value)
             SELECT $1::uuid, $2::uuid, $3, 'daily', d.window_start, d.value
             FROM unnest($4::date[], $5::numeric[]) AS d(window_start, value)
             ON CONFLICT (property_id, metric, window_start, granularity)
             DO UPDATE SET value = EXCLUDED.value, generated_at = now()`,
            [
              context.orgId,
              context.propertyId,
              metric.metric,
              result.rows.map((row) => normaliseDate(row.window_start)),
              result.rows.map((row) => row.value),
            ],
          );
          written += result.rows.length;
        }
      }
    }

    return {
      orgId: context.orgId,
      propertyId: context.propertyId,
      range: validated,
      rows,
      written,
      dryRun,
    };
  });
}

/**
 * `DATE` arrives from node-postgres as a JS `Date` at local midnight, which
 * `toISOString()` would shift backwards a day in any negative-offset time zone —
 * the same class of bug as #147. Pinning the type parser is not an option here
 * (it is global), so a `Date` is normalised from its UTC fields, which is where
 * pg placed the midnight.
 */
function normaliseDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** The days a range covers, for progress output and for the CLI's summary. */
export function daysInRange(range: RollupRange): number {
  const from = Date.parse(`${validateRange(range).from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}
