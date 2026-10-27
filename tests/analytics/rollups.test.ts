import { describe, expect, it } from "vitest";
import {
  ROLLUP_METRICS,
  ROLLUP_METRIC_NAMES,
  daysInRange,
  rangeForDate,
  validateRange,
} from "../../src/analytics/rollups.ts";

/**
 * S10-02 — the parts of the rollup that are pure.
 *
 * The time-zone boundary case named in the charter's test plan deliberately lives
 * in `tests/db/rollups.db.test.ts` instead of here: the day boundary is computed by
 * Postgres (`AT TIME ZONE`), and a JS re-implementation tested against itself would
 * prove only that two copies of the rule agree. One implementation, tested where it
 * runs, is the whole reason `days` is a SQL `generate_series` rather than a loop.
 */
describe("rollup metric registry", () => {
  it("defines every metric the dashboard renders, in order", () => {
    expect(ROLLUP_METRIC_NAMES).toEqual([
      "conversations_started",
      "messages_received",
      "ai_answers_sent",
      "escalations",
      "no_answers",
      "containment",
      "first_response_p95_seconds",
      "requests_created",
      "requests_acknowledged",
      "ack_median_seconds",
      "knowledge_gaps_opened",
      "knowledge_gaps_closed",
    ]);
  });

  it("has unique metric names — the upsert key is (property, metric, day)", () => {
    expect(new Set(ROLLUP_METRIC_NAMES).size).toBe(ROLLUP_METRICS.length);
  });

  it("every statement takes the four documented parameters and reads a real table", () => {
    for (const metric of ROLLUP_METRICS) {
      for (const parameter of ["$1", "$2", "$3", "$4"]) {
        expect(metric.sql, `${metric.metric} is missing ${parameter}`).toContain(parameter);
      }
      expect(metric.sql, metric.metric).toMatch(
        /FROM (events|conversations|messages|service_requests)/,
      );
      // A tile renders this text to a manager; `SELECT *` would not explain itself.
      expect(metric.sql, metric.metric).not.toContain("SELECT *");
      expect(metric.describes.length, metric.metric).toBeGreaterThan(10);
    }
  });

  it("marks only the percentile metrics as omitting empty days", () => {
    const omitting = ROLLUP_METRICS.filter((metric) => metric.omitEmptyDays).map((m) => m.metric);
    // A count of zero is a fact; a p95 of zero would read as "instant answer".
    expect(omitting).toEqual(["first_response_p95_seconds", "ack_median_seconds"]);
  });

  it("counts every count metric from events, so AC-2 is checkable against events", () => {
    for (const metric of ROLLUP_METRICS.filter((m) => m.unit === "count")) {
      expect(metric.source, metric.metric).toBe("events");
    }
  });
});

describe("rollup range validation", () => {
  it("accepts a single day and an inclusive range", () => {
    expect(rangeForDate("2026-10-25")).toEqual({ from: "2026-10-25", to: "2026-10-25" });
    expect(validateRange({ from: "2026-10-01", to: "2026-10-25" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-25",
    });
  });

  it("refuses a date that is not a calendar day", () => {
    expect(() => rangeForDate("2026-13-01")).toThrow(/calendar date/);
    expect(() => rangeForDate("25-10-2026")).toThrow(/calendar date/);
    expect(() => rangeForDate("")).toThrow(/calendar date/);
  });

  it("refuses a backwards range instead of silently writing nothing", () => {
    expect(() => validateRange({ from: "2026-10-25", to: "2026-10-01" })).toThrow(
      /is after/,
    );
  });

  it("counts the days a range covers", () => {
    expect(daysInRange({ from: "2026-10-25", to: "2026-10-25" })).toBe(1);
    expect(daysInRange({ from: "2026-10-23", to: "2026-10-25" })).toBe(3);
  });
});
