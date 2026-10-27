/**
 * S10-03 — the tile table: one tile per rollup metric, and the query that made it.
 *
 * The acceptance criterion is that **every tile is traceable to a query a manager
 * can explain**. Traceability is not a paragraph in a runbook here, it is the
 * data structure: a tile has no value of its own, only a `metric` (the
 * `rollups.metric` it displays), a `querySql` (the exact statement S10-02 ran,
 * imported from the registry rather than copied), and two catalogue ids.
 *
 * `querySql` is the *same string object* the upsert executed, not a second copy
 * of it. A copy would be correct on the day it was written and wrong at the first
 * edit, and the screen's whole promise is that "show query" shows what produced
 * the number. `tests/analytics/tiles.test.ts` asserts identity for every tile.
 *
 * The label map is a `Record<RollupMetricName, …>`, so adding a metric to the
 * rollup registry without adding its two strings is a **type error** — the failure
 * mode this prevents is a tile rendering a raw catalogue id like
 * `staff.analytics.tile.new_metric` on a manager's screen.
 */
import type { StringId } from "../i18n/catalog.ts";
import { ROLLUP_METRICS, type RollupMetricName, type RollupUnit } from "./rollups.ts";

/** How the value is *presented*. Never how it is computed. */
export type TileFormat = "count" | "percent" | "seconds";

export interface Tile {
  /** Stable DOM/test key; equal to `metric` because a tile is one metric. */
  id: string;
  metric: RollupMetricName;
  /** `rollups.metric` as it appears in the database, shown to the reader. */
  labelId: StringId;
  /** One sentence about what the number counts. */
  descriptionId: StringId;
  /** The exact statement from `src/analytics/rollups.ts`. */
  querySql: string;
  format: TileFormat;
  unit: RollupUnit;
}

const FORMAT_BY_UNIT: Record<RollupUnit, TileFormat> = {
  count: "count",
  ratio: "percent",
  seconds: "seconds",
};

/**
 * The two strings every tile needs, keyed by metric.
 *
 * A `satisfies` rather than a type annotation so the literal ids stay literal and
 * are checked against `StringId` — a typo fails to compile instead of shipping a
 * blank tile.
 */
const LABELS = {
  conversations_started: {
    labelId: "staff.analytics.tile.conversations_started",
    descriptionId: "staff.analytics.hint.conversations_started",
  },
  messages_received: {
    labelId: "staff.analytics.tile.messages_received",
    descriptionId: "staff.analytics.hint.messages_received",
  },
  ai_answers_sent: {
    labelId: "staff.analytics.tile.ai_answers_sent",
    descriptionId: "staff.analytics.hint.ai_answers_sent",
  },
  escalations: {
    labelId: "staff.analytics.tile.escalations",
    descriptionId: "staff.analytics.hint.escalations",
  },
  no_answers: {
    labelId: "staff.analytics.tile.no_answers",
    descriptionId: "staff.analytics.hint.no_answers",
  },
  containment: {
    labelId: "staff.analytics.tile.containment",
    descriptionId: "staff.analytics.hint.containment",
  },
  first_response_p95_seconds: {
    labelId: "staff.analytics.tile.first_response_p95_seconds",
    descriptionId: "staff.analytics.hint.first_response_p95_seconds",
  },
  requests_created: {
    labelId: "staff.analytics.tile.requests_created",
    descriptionId: "staff.analytics.hint.requests_created",
  },
  requests_acknowledged: {
    labelId: "staff.analytics.tile.requests_acknowledged",
    descriptionId: "staff.analytics.hint.requests_acknowledged",
  },
  ack_median_seconds: {
    labelId: "staff.analytics.tile.ack_median_seconds",
    descriptionId: "staff.analytics.hint.ack_median_seconds",
  },
  knowledge_gaps_opened: {
    labelId: "staff.analytics.tile.knowledge_gaps_opened",
    descriptionId: "staff.analytics.hint.knowledge_gaps_opened",
  },
  knowledge_gaps_closed: {
    labelId: "staff.analytics.tile.knowledge_gaps_closed",
    descriptionId: "staff.analytics.hint.knowledge_gaps_closed",
  },
} as const satisfies Record<RollupMetricName, { labelId: StringId; descriptionId: StringId }>;

/**
 * The dashboard, in the registry's order.
 *
 * Built from `ROLLUP_METRICS` rather than written out again so the metric name,
 * the unit and the statement cannot disagree with the rollup — the only thing
 * this file adds is presentation.
 */
export const TILES: readonly Tile[] = ROLLUP_METRICS.map((metric) => ({
  id: metric.metric,
  metric: metric.metric,
  labelId: LABELS[metric.metric].labelId,
  descriptionId: LABELS[metric.metric].descriptionId,
  querySql: metric.sql,
  format: FORMAT_BY_UNIT[metric.unit],
  unit: metric.unit,
}));

/** Lookup by metric, for a caller that has one and wants its tile. */
export const TILE_BY_METRIC: ReadonlyMap<string, Tile> = new Map(
  TILES.map((tile) => [tile.metric, tile]),
);
