/**
 * S10-01 — the pure half of the reconciliation.
 *
 * `reconcile()` itself needs a database and is covered by
 * tests/db/events.db.test.ts. What is covered here is the part that does not: the
 * metric list, and the wording of a drift report. The wording matters more than it
 * looks — "reconciliation failed" sends whoever is paged looking at all eight pairs
 * instead of the one that moved, so the message is asserted rather than trusted.
 */
import { describe, expect, it } from "vitest";
import {
  RECONCILE_METRICS,
  describeDrift,
  type ReconcileMetric,
  type ReconcileResult,
} from "../../src/events/reconcile.ts";

function metric(over: Partial<ReconcileMetric> = {}): ReconcileMetric {
  const businessRows = over.businessRows ?? 0;
  const events = over.events ?? 0;
  return {
    metric: "conversations",
    businessRows,
    events,
    delta: businessRows - events,
    countsEvent: "conversation_started",
    ...over,
  };
}

function result(metrics: ReconcileMetric[]): ReconcileResult {
  const drifted = metrics.filter((m) => m.delta !== 0);
  return { metrics, drifted, ok: drifted.length === 0 };
}

describe("RECONCILE_METRICS", () => {
  it("covers every business table whose rows are actions", () => {
    // Asserted as an exact list, not a length: adding a business table without
    // adding its metric is how a reconciliation quietly stops covering the product,
    // and a length check would pass on a swap as readily as on an addition.
    expect([...RECONCILE_METRICS]).toEqual([
      "conversations",
      "messages_inbound_guest",
      "messages_outbound_staff",
      "service_requests",
      "assignments",
      "answer_flags",
      "knowledge_gaps",
      "ai_runs",
    ]);
  });

  it("pairs assignments rather than requests with request_assigned", () => {
    // The pairing that is easy to get wrong: one request can carry several
    // assignees, so counting requests against request_assigned events under-reports
    // by one per additional assignee and looks like missing instrumentation.
    expect(RECONCILE_METRICS).toContain("assignments");
    expect(RECONCILE_METRICS).not.toContain("requests_assigned");
  });
});

describe("describeDrift", () => {
  it("says so plainly when nothing drifted", () => {
    expect(describeDrift(result([metric(), metric({ metric: "ai_runs" })]))).toBe(
      "reconciled: every metric delta is zero",
    );
  });

  it("names the metric that moved, its two counts, and a signed delta", () => {
    const drifted = result([
      metric(),
      metric({
        metric: "service_requests",
        businessRows: 12,
        events: 10,
        countsEvent: "request_created",
      }),
    ]);
    expect(drifted.ok).toBe(false);
    expect(describeDrift(drifted)).toBe(
      "service_requests: 12 business rows vs 10 request_created events (delta +2)",
    );
  });

  it("signs a negative delta, which means more events than actions", () => {
    // The other direction is a different defect — a double emission, or an event
    // with no action behind it — and an unsigned number would not distinguish it
    // from the missing-event case at a glance.
    const drifted = result([
      metric({ metric: "knowledge_gaps", businessRows: 3, events: 5, countsEvent: "knowledge_gap_created" }),
    ]);
    expect(describeDrift(drifted)).toBe(
      "knowledge_gaps: 3 business rows vs 5 knowledge_gap_created events (delta -2)",
    );
  });

  it("lists every drifted metric, not just the first", () => {
    const drifted = result([
      metric({ metric: "conversations", businessRows: 2, events: 1, countsEvent: "conversation_started" }),
      metric({ metric: "answer_flags", businessRows: 4, events: 1, countsEvent: "answer_flagged_wrong" }),
    ]);
    expect(drifted.drifted).toHaveLength(2);
    expect(describeDrift(drifted)).toBe(
      "conversations: 2 business rows vs 1 conversation_started events (delta +1); " +
        "answer_flags: 4 business rows vs 1 answer_flagged_wrong events (delta +3)",
    );
  });

  it("describes the ai_runs metric by what it actually counts", () => {
    // ai_runs has no single event type to name: four recordAiRun paths emit four
    // different terminal events, so the count is over distinct payload ids and the
    // report has to say that or it reads as a missing event type.
    const drifted = result([
      metric({ metric: "ai_runs", businessRows: 7, events: 6, countsEvent: "distinct payload->>'ai_run_id'" }),
    ]);
    expect(describeDrift(drifted)).toContain("distinct payload->>'ai_run_id'");
  });
});
