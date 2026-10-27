/**
 * S07-06 AC-3 — the counters an alert can be built on.
 *
 * Three things go wrong with a model in production, and each has a different
 * response:
 *
 *  - **`ai_fallback_total`** — the primary failed and the secondary answered.
 *    The guest is fine; the primary is not. A rise here is the early warning,
 *    hours before enough guests hit the outage path to notice.
 *  - **`ai_circuit_open_total`** — the primary was skipped for 60s. Fewer events
 *    than fallbacks, by construction: it counts distinct outages, not requests.
 *  - **`ai_parse_failure_total`** — a model answered and the answer was not the
 *    contract. This is the one the AC singles out, because it is the only
 *    failure that *silently* costs the guest an answer they could have had: the
 *    model looked healthy, the transport looked healthy, and the guest got
 *    "a person will reply" anyway.
 *  - **`ai_outage_total`** — both providers failed (S07-05). The end of the
 *    line, and the one that should page someone.
 *
 * ## Why in-memory counters and not a metrics endpoint
 *
 * The charter's instruction is "exposed via the existing `createLogger`", and
 * that is what this is: one structured log line per event, which is what a
 * log-based alert parses. A counter held in process memory is **per replica** and
 * resets on deploy, so it is explicitly not a system of record — `ai_runs` is
 * that, and it already carries `decision`, `reason_code` and
 * `usage.contract_violations` per call. These counters exist to make the event
 * cheap to emit and cheap to assert in a test, not to replace the table.
 *
 * ## Labels are a closed set, and that is a security property
 *
 * `org_id`, `property_id` and `model` only. The plan's rule is that metrics carry
 * tenant identity and never prompt or guest text, and a counter module that
 * accepts arbitrary labels is exactly how guest text ends up in a log line.
 * Unknown label keys are **dropped**, not passed through: a caller that tries to
 * attach `question` gets a counter without it, rather than a leak.
 */

export const COUNTER_NAMES = [
  "ai_parse_failure_total",
  "ai_fallback_total",
  "ai_circuit_open_total",
  "ai_outage_total",
  // S11-03 — a guest's turn was refused because it carried a card number. The
  // count is the only trace: the message itself is never written, so this is how an
  // operator sees that guests are pasting card numbers at all. Not an event: the
  // event list is Appendix C, verbatim (see S11-03-1 in the runbook).
  "pii_blocked_total",
] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];

/** The only label keys a counter may carry. */
export const METRIC_LABEL_KEYS = ["org_id", "property_id", "model"] as const;
export type MetricLabelKey = (typeof METRIC_LABEL_KEYS)[number];
export type MetricLabels = Partial<Record<MetricLabelKey, string>>;

export interface CounterEntry {
  name: CounterName;
  labels: MetricLabels;
  value: number;
}

/**
 * pino-shaped logger. Typed structurally so this module does not import the
 * logger's full surface (and so a test can pass a spy).
 */
export interface CounterLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Silent until the server turns it on. Same precedent as `withResilience`: a
 * module that logs by default prints from production-shaped code paths in tests
 * and scripts.
 */
let logger: CounterLogger | null = null;

/** Called once at boot (`src/server.ts`); tests leave metrics silent. */
export function setCounterLogger(next: CounterLogger | null): void {
  logger = next;
}

/** Drops unknown keys. Never throws: a metric must not fail a guest request. */
function sanitiseLabels(labels: MetricLabels | undefined): MetricLabels {
  if (labels === undefined) return {};
  const clean: MetricLabels = {};
  for (const key of METRIC_LABEL_KEYS) {
    const value = labels[key];
    if (typeof value === "string" && value !== "") clean[key] = value;
  }
  return clean;
}

/** Stable key, so `{a,b}` and `{b,a}` are one series. */
function seriesKey(name: CounterName, labels: MetricLabels): string {
  const parts = METRIC_LABEL_KEYS.filter((key) => labels[key] !== undefined).map(
    (key) => `${key}=${labels[key]}`,
  );
  return `${name}{${parts.join(",")}}`;
}

const counts = new Map<string, CounterEntry>();

/**
 * Adds one to a counter and, when logging is on, emits one structured line.
 *
 * Never throws: instrumentation that can fail a request is worse than no
 * instrumentation.
 */
export function incrementCounter(
  name: CounterName,
  labels?: MetricLabels,
  by = 1,
): void {
  const clean = sanitiseLabels(labels);
  const key = seriesKey(name, clean);
  const existing = counts.get(key);
  const value = (existing?.value ?? 0) + by;
  counts.set(key, { name, labels: clean, value });
  try {
    logger?.info({ counter: name, ...clean, value }, "metrics.counter");
  } catch {
    // The registry is updated and the count is right; only the log line failed.
    // Swallowing here is deliberate: a broken sink must not fail a guest turn.
  }
}

/** Current value of one series. Missing means zero — a counter, not a record. */
export function counterValue(name: CounterName, labels?: MetricLabels): number {
  return counts.get(seriesKey(name, sanitiseLabels(labels)))?.value ?? 0;
}

/** Total across every series of one counter, for "how much of this happened". */
export function counterTotal(name: CounterName): number {
  let total = 0;
  for (const entry of counts.values()) if (entry.name === name) total += entry.value;
  return total;
}

/** A copy, sorted, so a caller cannot mutate the registry by holding it. */
export function countersSnapshot(): CounterEntry[] {
  return [...counts.values()]
    .map((entry) => ({ name: entry.name, labels: { ...entry.labels }, value: entry.value }))
    .sort((a, b) => seriesKey(a.name, a.labels).localeCompare(seriesKey(b.name, b.labels)));
}

/** Tests only. Production never resets: a counter that goes down is a lie. */
export function resetCounters(): void {
  counts.clear();
}
