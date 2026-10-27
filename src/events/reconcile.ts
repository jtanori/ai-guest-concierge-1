/**
 * S10-01 AC-3 — the reconciliation behind D10's promise that "dashboard numbers
 * reconcile exactly to raw events".
 *
 * A dashboard is a summary of `events`. If a business row can exist without its
 * event, every number built on that event is quietly low, and nobody can tell from
 * the dashboard — the missing row is invisible by definition. This module makes the
 * gap measurable instead: for each metric it counts what the business tables say
 * happened and what `events` says happened, and returns the difference. Zero is the
 * only acceptable answer, and `tests/db/events.db.test.ts` asserts it after driving
 * real production paths.
 *
 * WHAT IS PAIRED, AND WHY THESE PAIRS. Each metric below was checked against every
 * INSERT site for that table, not assumed:
 *
 * - `conversations` ↔ `conversation_started` — one insert site (guest/service.ts),
 *   which emits exactly when the conversation is new.
 * - inbound guest `messages` ↔ `message_received` — one insert site, emits every time.
 * - outbound staff `messages` ↔ `staff_message_sent` — `insertStaffMessage` has one
 *   caller (replyAsStaff), which emits every time.
 * - `service_requests` ↔ `request_created` — one insert site (requests/capture.ts).
 * - `assignments` ↔ `request_assigned` — NOT requests: one request can carry several
 *   assignees, so the event counts assignments. Two insert sites (lifecycle.ts for
 *   the first assignee, inbox/actions.ts for an additional one) and both emit.
 * - `answer_flags` ↔ `answer_flagged_wrong` — one insert site (inbox/flags.ts).
 * - `knowledge_gaps` ↔ `knowledge_gap_created` — one PRODUCTION insert site
 *   (gaps/queue.ts). See the seed caveat below.
 * - `ai_runs` ↔ distinct `payload->>'ai_run_id'` — there is no single event type to
 *   pair with. `recordAiRun` is called from four paths and each emits a DIFFERENT
 *   terminal event (`ai_run_completed`, `message_failed`, or `ai_escalated` for the
 *   policy-block and guardrail gates), so counting one type would under-report and
 *   counting all three would over-report, because `ai_escalated` is also emitted on
 *   paths that never record a run. Every one of the four carries `ai_run_id` in its
 *   payload, so the distinct set of those ids is the exact image of the table.
 *
 * THE SEED CAVEAT, stated rather than hidden: `src/seed/demo.ts` writes business rows
 * (including `knowledge_gaps`) with no `emitEvent` call at all — it has zero. A demo
 * property therefore does NOT reconcile, and cannot: its rows were never actions.
 * That is a property of the fixture, not of the product path, so reconciliation is
 * defined over rows written through production code. Driving the demo seed through
 * the emitter would change what the fixture means and is S10-03's problem to want,
 * not this item's to assume.
 *
 * One statement, so every count comes from one snapshot: fourteen separate queries
 * could straddle a concurrent write and report a delta that never existed.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";

/**
 * Inclusive lower bound, exclusive upper bound; either may be omitted.
 *
 * WINDOWING IS SAFE BECAUSE THERE IS ONLY ONE CLOCK — issue #147, resolved by option 3.
 *
 * It used not to be. Business tables take `created_at` from Postgres (`DEFAULT now()`,
 * the transaction timestamp) while the paired event took a JS-side `new Date()` read
 * elsewhere in the same request. A `from`/`to` falling between those two readings put
 * the row inside the window and its event outside it, and the metric reported `delta ±1`
 * — a timing artifact wearing the costume of missing instrumentation, which is the one
 * thing a reconciliation must never claim.
 *
 * Each producer now reads its own row's `created_at` back out of its INSERT and hands
 * that exact value to `emitEvent` (see `src/events/clock.ts`), so a row and its event
 * carry one identical stamp and no boundary can fall between them. This is asserted, not
 * assumed: `tests/db/clock-agreement.db.test.ts` drives the real producers for all eight
 * metrics and compares the two `created_at` values **in SQL**, because comparing them in
 * JS would round both to milliseconds and pass with the rows 999us apart.
 *
 * Two things would break it, and both are guarded:
 *
 *  - A producer stamping an event from a JS clock again. The suite injects a `deps.now`
 *    three decades off and asserts that no event anywhere carries it.
 *  - An event that *names* a row it was not written with. This is not hypothetical: it
 *    was a live bug in the `ai_runs` metric, which counted `DISTINCT payload->>'ai_run_id'`
 *    over every event — including `answer_flagged_wrong`, written when a person reviews
 *    the answer, possibly days later. A window holding the flag but not the run counted
 *    one distinct run against zero rows. See AI_RUN_TERMINAL_EVENT_TYPES.
 *
 * `reconcile()` still has no production caller: S10-02's rollups and S10-03's dashboard
 * are what will consume it, and the windowed path is now safe for them to build on.
 */
export interface ReconcileWindow {
  from?: Date | null;
  to?: Date | null;
}

export interface ReconcileMetric {
  /** Stable name, used by the test and by S10-02's rollups. */
  metric: string;
  /** What the business tables say happened. */
  businessRows: number;
  /** What `events` says happened. */
  events: number;
  /** businessRows - events. Zero is the pass condition. */
  delta: number;
  /** What the event side counts, for the failure message that names it. */
  countsEvent: string;
}

export interface ReconcileResult {
  metrics: ReconcileMetric[];
  /** Metrics whose delta is not zero. Empty is the pass condition. */
  drifted: ReconcileMetric[];
  ok: boolean;
}

/**
 * Every metric the reconciliation covers, in the order it reports them. Exported so
 * a test can assert the set itself — adding a business table without adding its
 * metric is how reconciliation quietly stops covering the product.
 */
export const RECONCILE_METRICS = [
  "conversations",
  "messages_inbound_guest",
  "messages_outbound_staff",
  "service_requests",
  "assignments",
  "answer_flags",
  "knowledge_gaps",
  "ai_runs",
] as const;

export type ReconcileMetricName = (typeof RECONCILE_METRICS)[number];

/**
 * One row, one column per count. Every key here is an output alias in QUERY and
 * every alias in QUERY appears here — `tsc` is what enforces that, since PAIRS
 * indexes this type, so a renamed alias fails to compile rather than reading as
 * `undefined` and reporting a delta of NaN.
 */
interface CountRow {
  conversations: string;
  conversation_started: string;
  message_received: string;
  message_received_events: string;
  staff_message_sent: string;
  staff_message_sent_events: string;
  service_requests: string;
  request_created: string;
  assignments: string;
  request_assigned: string;
  answer_flags: string;
  answer_flagged_wrong: string;
  knowledge_gaps: string;
  knowledge_gap_created: string;
  ai_runs: string;
  ai_run_ids: string;
}

/**
 * The event types emitted in the SAME transaction as the `ai_runs` row they name, and
 * therefore the only ones the `ai_runs` metric may count.
 *
 * This filter is a bug fix, not a tidy-up. The metric compares `count(*)` over
 * `ai_runs` against `count(DISTINCT payload->>'ai_run_id')` over `events`, each windowed
 * on its own `created_at`. Counting *every* event that names a run breaks that
 * comparison, because some events name a run long after it happened: `answer_flagged_wrong`
 * is written when a person reviews the answer, which can be days later. A window covering
 * the flag but not the run then counted one distinct run on the event side and zero rows
 * on the business side — `delta -1`, phantom drift reported against a database in which
 * nothing was missing. It is the same failure class as issue #147 (a windowed
 * reconciliation inventing a delta), reached by a different route: not two clocks
 * disagreeing about one moment, but two moments being counted as one.
 *
 * Excluded deliberately: `answer_flagged_wrong`. It is the paired event of the
 * `answer_flags` metric, where its own row supplies the timestamp, and it must not also
 * speak for the run.
 *
 * Drift guard: `tests/db/clock-agreement.db.test.ts` fails if an event type outside this
 * list is ever found carrying `ai_run_id`, so adding a new run-terminal event means
 * adding it here too rather than silently under-counting.
 */
export const AI_RUN_TERMINAL_EVENT_TYPES = [
  "ai_run_completed",
  "ai_answer_sent",
  "ai_escalated",
  "no_answer_emitted",
  "message_failed",
] as const;

const AI_RUN_EVENT_FILTER =
  `e.event_type IN (${AI_RUN_TERMINAL_EVENT_TYPES.map((t) => `'${t}'`).join(", ")})`;

// The window predicate is repeated per table rather than factored into a SQL
// function: a function would need to be created by a migration to be usable here,
// and an inline predicate keeps this module readable against `\d` output.
const W_FROM = "($3::timestamptz IS NULL OR %I.created_at >= $3::timestamptz)";
const W_TO = "($4::timestamptz IS NULL OR %I.created_at < $4::timestamptz)";

function windowOn(alias: string): string {
  return `${W_FROM.replaceAll("%I", alias)} AND ${W_TO.replaceAll("%I", alias)}`;
}

function businessCount(table: string, alias: string, extra = ""): string {
  return `(SELECT count(*) FROM ${table} ${alias}
            WHERE ${alias}.org_id = $1 AND ${alias}.property_id = $2
              ${extra} AND ${windowOn(alias)})`;
}

function eventCount(eventType: string): string {
  return `(SELECT count(*) FROM events e
            WHERE e.org_id = $1 AND e.property_id = $2
              AND e.event_type = '${eventType}' AND ${windowOn("e")})`;
}

const QUERY = `SELECT
  ${businessCount("conversations", "c")} AS conversations,
  ${eventCount("conversation_started")} AS conversation_started,
  ${businessCount("messages", "m", "AND m.direction = 'inbound' AND m.author_role = 'guest'")} AS message_received,
  ${eventCount("message_received")} AS message_received_events,
  ${businessCount("messages", "s", "AND s.direction = 'outbound' AND s.author_role = 'staff'")} AS staff_message_sent,
  ${eventCount("staff_message_sent")} AS staff_message_sent_events,
  ${businessCount("service_requests", "r")} AS service_requests,
  ${eventCount("request_created")} AS request_created,
  ${businessCount("assignments", "a")} AS assignments,
  ${eventCount("request_assigned")} AS request_assigned,
  ${businessCount("answer_flags", "f")} AS answer_flags,
  ${eventCount("answer_flagged_wrong")} AS answer_flagged_wrong,
  ${businessCount("knowledge_gaps", "g")} AS knowledge_gaps,
  ${eventCount("knowledge_gap_created")} AS knowledge_gap_created,
  ${businessCount("ai_runs", "u")} AS ai_runs,
  (SELECT count(DISTINCT e.payload->>'ai_run_id') FROM events e
    WHERE e.org_id = $1 AND e.property_id = $2
      AND ${AI_RUN_EVENT_FILTER}
      AND e.payload ? 'ai_run_id'
      AND e.payload->>'ai_run_id' IS NOT NULL
      AND ${windowOn("e")}) AS ai_run_ids`;

// Built once: the aliases above are static literals in this module, and the
// column names the SELECT returns are not the same as the metric names, so this
// maps each metric to its two count columns explicitly rather than by convention.
const PAIRS: ReadonlyArray<{
  metric: ReconcileMetricName;
  business: keyof CountRow;
  events: keyof CountRow;
  countsEvent: string;
}> = [
  { metric: "conversations", business: "conversations", events: "conversation_started", countsEvent: "conversation_started" },
  { metric: "messages_inbound_guest", business: "message_received", events: "message_received_events", countsEvent: "message_received" },
  { metric: "messages_outbound_staff", business: "staff_message_sent", events: "staff_message_sent_events", countsEvent: "staff_message_sent" },
  { metric: "service_requests", business: "service_requests", events: "request_created", countsEvent: "request_created" },
  { metric: "assignments", business: "assignments", events: "request_assigned", countsEvent: "request_assigned" },
  { metric: "answer_flags", business: "answer_flags", events: "answer_flagged_wrong", countsEvent: "answer_flagged_wrong" },
  { metric: "knowledge_gaps", business: "knowledge_gaps", events: "knowledge_gap_created", countsEvent: "knowledge_gap_created" },
  { metric: "ai_runs", business: "ai_runs", events: "ai_run_ids", countsEvent: "distinct payload->>'ai_run_id'" },
];

/**
 * Count business rows against their events for one tenant, over one window.
 *
 * Runs on the caller's client and does not open a transaction: it is a read, and a
 * caller reconciling inside a write transaction should see that transaction's own
 * rows. Tenant scoping is by explicit predicate as well as RLS, matching the rest of
 * the codebase, so the query is correct even on a connection that never set a role.
 */
/**
 * No production caller yet, and that is stated rather than left to be discovered:
 * `reconcile()` is exercised by tests until S10-02's rollups or S10-03's dashboard
 * consumes it. Both are out of scope for S10-01 by charter §3.
 */
export async function reconcile(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  window: ReconcileWindow = {},
): Promise<ReconcileResult> {
  assertTenantShape(context);
  const from = window.from ?? null;
  const to = window.to ?? null;
  if (from !== null && to !== null && from.getTime() >= to.getTime()) {
    throw new Error("reconcile window: 'from' must be earlier than 'to'");
  }

  const result = await client.query<CountRow>(QUERY, [
    context.orgId,
    context.propertyId,
    from,
    to,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error("reconcile query returned no row");

  const metrics: ReconcileMetric[] = PAIRS.map(({ metric, business, events, countsEvent }) => {
    const businessRows = Number(row[business]);
    const eventCountValue = Number(row[events]);
    return {
      metric,
      businessRows,
      events: eventCountValue,
      delta: businessRows - eventCountValue,
      countsEvent,
    };
  });
  const drifted = metrics.filter((m) => m.delta !== 0);

  return { metrics, drifted, ok: drifted.length === 0 };
}

/**
 * The failure message, so a drift reads as a diagnosis rather than as a number.
 * Named per metric: "reconciliation failed" sends whoever is paged looking at all
 * eight pairs instead of the one that moved.
 */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

export function describeDrift(result: ReconcileResult): string {
  if (result.ok) return "reconciled: every metric delta is zero";
  return result.drifted
    .map(
      (m) =>
        `${m.metric}: ${m.businessRows} business ${plural(m.businessRows, "row")} vs ` +
        `${m.events} ${m.countsEvent} ${plural(m.events, "event")} ` +
        `(delta ${m.delta > 0 ? "+" : ""}${m.delta})`,
    )
    .join("; ");
}
