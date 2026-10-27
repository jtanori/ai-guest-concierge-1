/**
 * S07-06 AC-3 — the counters, and the rule that makes them safe to log.
 *
 * The interesting cases are not "+1 works". They are:
 *
 *  - **a label the module does not know is dropped**, because that is the
 *    difference between a metric and a leak (guest text in a log line);
 *  - **label order does not split a series**, or the same counter would look like
 *    two and every rate would be wrong;
 *  - **nothing here throws**, because instrumentation that can fail a guest
 *    request is worse than no instrumentation;
 *  - **nothing logs unless the server turns logging on**, because tests and
 *    scripts import these same modules.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COUNTER_NAMES,
  METRIC_LABEL_KEYS,
  counterTotal,
  counterValue,
  countersSnapshot,
  incrementCounter,
  resetCounters,
  setCounterLogger,
} from "../../src/metrics/counters.ts";

beforeEach(() => {
  resetCounters();
  setCounterLogger(null);
});

describe("counting", () => {
  it("counts a series, and a missing series is zero rather than undefined", () => {
    expect(counterValue("ai_fallback_total")).toBe(0);
    incrementCounter("ai_fallback_total");
    incrementCounter("ai_fallback_total");
    expect(counterValue("ai_fallback_total")).toBe(2);
  });

  it("keeps series apart by label value", () => {
    incrementCounter("ai_fallback_total", { org_id: "org-a", model: "m1" });
    incrementCounter("ai_fallback_total", { org_id: "org-b", model: "m1" });
    incrementCounter("ai_fallback_total", { org_id: "org-a", model: "m2" });
    expect(counterValue("ai_fallback_total", { org_id: "org-a", model: "m1" })).toBe(1);
    expect(counterValue("ai_fallback_total", { org_id: "org-b", model: "m1" })).toBe(1);
    expect(counterTotal("ai_fallback_total")).toBe(3);
  });

  it("treats label order as one series, so a rate cannot be halved", () => {
    incrementCounter("ai_fallback_total", { org_id: "o", property_id: "p", model: "m" });
    incrementCounter("ai_fallback_total", { model: "m", property_id: "p", org_id: "o" });
    expect(counterTotal("ai_fallback_total")).toBe(2);
    expect(countersSnapshot()).toHaveLength(1);
  });

  it("adds more than one at a time when asked", () => {
    incrementCounter("ai_fallback_total", undefined, 5);
    expect(counterValue("ai_fallback_total")).toBe(5);
  });

  it("names a closed vocabulary, so an invented counter is a type error", () => {
    expect(COUNTER_NAMES).toEqual([
      "ai_parse_failure_total",
      "ai_fallback_total",
      "ai_circuit_open_total",
      "ai_outage_total",
      // S11-03 — a guest turn was refused because it carried a card number. It is a
      // counter rather than an event because Appendix C's event list is verbatim;
      // this test is what makes adding either a deliberate, reviewable edit.
      "pii_blocked_total",
      // S11-05 — nightly reconciliation found drift. Its alert consumer is S11-04,
      // which cannot be built until S11-01 unblocks.
      "embedding_drift_total",
    ]);
  });
});

describe("labels", () => {
  it("drops every key that is not org_id, property_id or model", () => {
    // The plan's rule: metrics carry tenant identity, never prompt or guest text.
    // A caller that tries to attach the guest's question gets a counter without
    // it — not a log line with it.
    incrementCounter("ai_parse_failure_total", {
      org_id: "o",
      question: "¿Puedo pagar con tarjeta?",
      body: "guest text",
    } as never);
    const [entry] = countersSnapshot();
    expect(entry!.labels).toEqual({ org_id: "o" });
    expect(JSON.stringify(countersSnapshot())).not.toContain("tarjeta");
    expect(METRIC_LABEL_KEYS).toEqual(["org_id", "property_id", "model"]);
  });

  it("drops empty values rather than creating a blank series", () => {
    incrementCounter("ai_outage_total", { property_id: "" });
    expect(countersSnapshot()[0]!.labels).toEqual({});
    expect(counterValue("ai_outage_total")).toBe(1);
  });
});

describe("logging", () => {
  it("is silent until the server turns it on", () => {
    const info = vi.fn();
    incrementCounter("ai_outage_total");
    setCounterLogger({ info });
    incrementCounter("ai_outage_total");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith({ counter: "ai_outage_total", value: 2 }, "metrics.counter");
  });

  it("emits one structured line per event, which is what an alert parses", () => {
    const lines: Array<Record<string, unknown>> = [];
    setCounterLogger({ info: (fields) => lines.push(fields) });
    incrementCounter("ai_parse_failure_total", { org_id: "o", property_id: "p", model: "gemini-2.5-flash" });
    expect(lines).toEqual([
      {
        counter: "ai_parse_failure_total",
        org_id: "o",
        property_id: "p",
        model: "gemini-2.5-flash",
        value: 1,
      },
    ]);
  });

  it("survives a logger that throws — instrumentation must not fail a request", () => {
    setCounterLogger({
      info: () => {
        throw new Error("sink is broken");
      },
    });
    expect(() => incrementCounter("ai_outage_total")).not.toThrow();
  });
});

describe("the snapshot", () => {
  it("is a copy: mutating it cannot change a counter", () => {
    incrementCounter("ai_fallback_total", { org_id: "o" });
    const snapshot = countersSnapshot();
    snapshot[0]!.value = 999;
    snapshot[0]!.labels.org_id = "tampered";
    expect(counterValue("ai_fallback_total", { org_id: "o" })).toBe(1);
  });

  it("is sorted, so a diff between two reads is readable", () => {
    incrementCounter("ai_outage_total", { org_id: "b" });
    incrementCounter("ai_fallback_total", { org_id: "a" });
    incrementCounter("ai_parse_failure_total");
    expect(countersSnapshot().map((entry) => entry.name)).toEqual([
      "ai_fallback_total",
      "ai_outage_total",
      "ai_parse_failure_total",
    ]);
  });
});
