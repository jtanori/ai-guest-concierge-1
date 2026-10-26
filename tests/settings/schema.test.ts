/**
 * S02-02 - settings parser. The DB CHECK mirrors these rules; here we pin the
 * path-aware failures the app sees.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  parsePropertySettings,
  SettingsValidationError,
  type PropertySettings,
} from "../../src/settings/schema.ts";

function base(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;
}

function expectPath(value: unknown, path: string): void {
  try {
    parsePropertySettings(value);
    throw new Error("expected SettingsValidationError");
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsValidationError);
    expect((error as SettingsValidationError).path).toBe(path);
  }
}

describe("property settings schema", () => {
  it("parses DEFAULT_SETTINGS to itself (idempotent)", () => {
    expect(parsePropertySettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("treats {} as the legacy sentinel and returns a fresh default copy", () => {
    const parsed = parsePropertySettings({});
    expect(parsed).toEqual(DEFAULT_SETTINGS);
    parsed.enabled_topics.push("mutated");
    expect(DEFAULT_SETTINGS.enabled_topics).toEqual([]);
  });

  it("round-trips a complete custom object", () => {
    const value = base();
    value["tone"] = "formal";
    value["enabled_topics"] = ["wifi", "parking"];
    value["retention_days"] = 365;
    value["spend_cap"] = { daily_usd: 25, per_conversation_usd: 1.25 };
    value["escalation"] = {
      contacts: [{ name: "Front desk", channel: "in_app", value: "desk" }],
    };
    const hours = value["business_hours"] as Array<Record<string, unknown>>;
    hours[0] = { day: 0, closed: true };
    hours[1] = { day: 1, closed: false, open: "09:30", close: "17:00" };

    const parsed = parsePropertySettings(value);
    expect(parsed.tone).toBe("formal");
    expect(parsed.business_hours[0]).toEqual({ day: 0, closed: true });
    expect(parsed.business_hours[1]).toEqual({
      day: 1,
      closed: false,
      open: "09:30",
      close: "17:00",
    });
    expect(parsed.escalation.contacts).toHaveLength(1);
    expect(parsed.enabled_topics).toEqual(["wifi", "parking"]);
    expect(parsed.retention_days).toBe(365);
  });

  it("rejects a non-object and unknown/missing keys by path", () => {
    expectPath(null, "");
    expectPath([], "");
    const extra = base();
    extra["shouty"] = true;
    expectPath(extra, "shouty");

    const missing = base();
    delete missing["tone"];
    expectPath(missing, "tone");
  });

  it("rejects a partial object (only {} is a sentinel)", () => {
    expectPath({ tone: "formal" }, "business_hours");
  });

  it("rejects an unknown tone", () => {
    const value = base();
    value["tone"] = "shouty";
    expectPath(value, "tone");
  });

  it("rejects the wrong number of days", () => {
    const value = base();
    value["business_hours"] = (value["business_hours"] as unknown[]).slice(0, 6);
    expectPath(value, "business_hours");
  });

  it("rejects duplicate or unsorted days", () => {
    const value = base();
    const hours = value["business_hours"] as Array<Record<string, unknown>>;
    hours[1] = { ...hours[1], day: 0 };
    expectPath(value, "business_hours[1].day");
  });

  it("rejects a closed day that carries open/close", () => {
    const value = base();
    const hours = value["business_hours"] as Array<Record<string, unknown>>;
    hours[0] = { day: 0, closed: true, open: "08:00", close: "22:00" };
    expectPath(value, "business_hours[0].close");
  });

  it("rejects open >= close and bad time formats", () => {
    const equal = base();
    const equalHours = equal["business_hours"] as Array<Record<string, unknown>>;
    equalHours[0] = { day: 0, closed: false, open: "08:00", close: "08:00" };
    expectPath(equal, "business_hours[0].close");

    const bad = base();
    const badHours = bad["business_hours"] as Array<Record<string, unknown>>;
    badHours[0] = { day: 0, closed: false, open: "8:00", close: "22:00" };
    expectPath(bad, "business_hours[0].open");
  });

  it("rejects an all-closed week", () => {
    const value = base();
    value["business_hours"] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: true }));
    expectPath(value, "business_hours");
  });

  it("rejects bad contacts", () => {
    const emptyName = base();
    emptyName["escalation"] = {
      contacts: [{ name: "", channel: "in_app", value: "desk" }],
    };
    expectPath(emptyName, "escalation.contacts[0].name");

    const badChannel = base();
    badChannel["escalation"] = {
      contacts: [{ name: "Desk", channel: "sms", value: "555" }],
    };
    expectPath(badChannel, "escalation.contacts[0].channel");
  });

  it("rejects zero/negative spend caps", () => {
    const zero = base();
    zero["spend_cap"] = { daily_usd: 0, per_conversation_usd: 0.5 };
    expectPath(zero, "spend_cap.daily_usd");

    const negative = base();
    negative["spend_cap"] = { daily_usd: 10, per_conversation_usd: -1 };
    expectPath(negative, "spend_cap.per_conversation_usd");
  });

  it("rejects retention outside 1..3650 and non-integers", () => {
    const zero = base();
    zero["retention_days"] = 0;
    expectPath(zero, "retention_days");

    const tooLong = base();
    tooLong["retention_days"] = 3651;
    expectPath(tooLong, "retention_days");

    const fractional = base();
    fractional["retention_days"] = 90.5;
    expectPath(fractional, "retention_days");
  });

  it("rejects non-string and empty topics", () => {
    const nonString = base();
    nonString["enabled_topics"] = [42];
    expectPath(nonString, "enabled_topics[0]");

    const empty = base();
    empty["enabled_topics"] = [""];
    expectPath(empty, "enabled_topics[0]");
  });

  it("requires the retrieval weights key and defaults all three to 1 (0013)", () => {
    // REQUIRED, not optional: an unweighted property would silently get a
    // different ranking than the one the operator saw, and a missing key can
    // not be distinguished from "nobody chose".
    expect(DEFAULT_SETTINGS.retrieval_weights).toEqual({ lexical: 1, vector: 1, trigram: 1 });

    const missing = base();
    delete missing["retrieval_weights"];
    expectPath(missing, "retrieval_weights");

    expectPath({ ...base(), retrieval_weights: [] }, "retrieval_weights");

    // A missing key is named, not lumped under the object: the operator needs
    // to know WHICH weight the write forgot.
    const partial = base();
    partial["retrieval_weights"] = { lexical: 1, vector: 1 };
    expectPath(partial, "retrieval_weights.trigram");

    const extra = base();
    extra["retrieval_weights"] = { lexical: 1, vector: 1, trigram: 1, bm25: 1 };
    expectPath(extra, "retrieval_weights.bm25");

    // All zero would disable every branch and return nothing for every
    // question, which is indistinguishable from "no knowledge".
    const allZero = base();
    allZero["retrieval_weights"] = { lexical: 0, vector: 0, trigram: 0 };
    expectPath(allZero, "retrieval_weights");

    for (const key of ["lexical", "vector", "trigram"] as const) {
      const negative = base();
      negative["retrieval_weights"] = { lexical: 1, vector: 1, trigram: 1, [key]: -0.5 };
      expectPath(negative, `retrieval_weights.${key}`);

      const notNumber = base();
      notNumber["retrieval_weights"] = { lexical: 1, vector: 1, trigram: 1, [key]: "1" };
      expectPath(notNumber, `retrieval_weights.${key}`);
    }

    // A single non-zero weight is legitimate: pure lexical is a real setup.
    const lexicalOnly = base();
    lexicalOnly["retrieval_weights"] = { lexical: 1, vector: 0, trigram: 0 };
    expect(parsePropertySettings(lexicalOnly).retrieval_weights).toEqual({
      lexical: 1,
      vector: 0,
      trigram: 0,
    });

    // Weights are relative, so they are not capped at 1.
    const heavy = base();
    heavy["retrieval_weights"] = { lexical: 4, vector: 2, trigram: 0.5 };
    expect(parsePropertySettings(heavy).retrieval_weights.lexical).toBe(4);
  });

  it("merges top-level keys and keeps siblings", () => {
    const current: PropertySettings = structuredClone(DEFAULT_SETTINGS);
    const merged = mergeSettings(current, { tone: "concise", retention_days: 30 });
    expect(merged.tone).toBe("concise");
    expect(merged.retention_days).toBe(30);
    expect(merged.business_hours).toEqual(current.business_hours);
    expect(merged.spend_cap).toEqual(current.spend_cap);
  });
});
