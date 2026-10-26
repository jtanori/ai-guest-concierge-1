/**
 * S03-03 - fact validation and the lookup contract, without a database.
 *
 * The AC ("Pool hours answered by lookup, not generation") has to be provable
 * in a unit test too: `FACT_LOOKUP_SQL` is exported so this file can assert
 * it is a read over one table with no write clause, no embedding column, no
 * ranking expression and no provider call.
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  FACT_CONTRADICTIONS_SQL,
  FACT_LIMITS,
  FACT_LOOKUP_SQL,
  FACT_UNITS,
  FactValidationError,
  isRealDate,
  lookupFact,
  propertyLocalDate,
  validateEffectiveFrom,
  validateFactInput,
  validateFactKey,
  validateFactLanguage,
  validateFactUnit,
  validateFactValue,
  validateSourceArticleVersionId,
  type FactInput,
} from "../../src/knowledge/facts.ts";

function input(overrides: Partial<FactInput> = {}): FactInput {
  return {
    topicKey: "pool.hours",
    factKey: "closing_time",
    value: "21:00",
    unit: "time-of-day",
    language: "es",
    effectiveFrom: "2026-01-01",
    ...overrides,
  };
}

function invalidKey(field: "topicKey" | "factKey", value: unknown): FactValidationError {
  try {
    validateFactKey(value, field);
  } catch (error) {
    expect(error).toBeInstanceOf(FactValidationError);
    return error as FactValidationError;
  }
  throw new Error("expected validation to fail");
}

describe("fact validation (S03-03)", () => {
  it("accepts the fixture's keys and rejects empty, overlong or mixed-case keys", () => {
    expect(validateFactKey("closing_time", "factKey")).toBe("closing_time");
    expect(validateFactKey("  pool.hours  ", "topicKey")).toBe("pool.hours");
    expect(validateFactKey("massage_60", "factKey")).toBe("massage_60");

    for (const bad of ["", "   ", "Closing_Time", "pool hours", ".pool", "pool.", "pool..hours"]) {
      expect(invalidKey("factKey", bad).field, bad).toBe("factKey");
    }
    expect(invalidKey("topicKey", "x".repeat(FACT_LIMITS.key + 1)).field).toBe("topicKey");
    expect(invalidKey("topicKey", 42).field).toBe("topicKey");
  });

  it("trims a value and rejects empty, overlong or NUL-bearing values", () => {
    expect(validateFactValue("  21:00  ")).toBe("21:00");
    expect(validateFactValue("24/7")).toBe("24/7");
    expect(validateFactValue("x".repeat(FACT_LIMITS.value))).toHaveLength(FACT_LIMITS.value);

    for (const bad of ["", "    ", "bad\u0000value"]) {
      try {
        validateFactValue(bad);
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(FactValidationError);
      }
    }
    try {
      validateFactValue("x".repeat(FACT_LIMITS.value + 1));
      throw new Error("expected failure");
    } catch (error) {
      expect((error as FactValidationError).field).toBe("value");
    }
    try {
      validateFactValue(7);
      throw new Error("expected failure");
    } catch (error) {
      expect((error as FactValidationError).field).toBe("value");
    }
  });

  it("keeps the unit set closed", () => {
    for (const unit of FACT_UNITS) {
      expect(validateFactUnit(unit)).toBe(unit);
    }
    for (const bad of ["", "metres", "Time-of-Day", "text "]) {
      try {
        validateFactUnit(bad);
        throw new Error("expected failure");
      } catch (error) {
        expect((error as FactValidationError).field).toBe("unit");
      }
    }
  });

  it("accepts 2-8 lowercase letters for language (the fixture uses fr), not en-US or prose", () => {
    expect(validateFactLanguage("es")).toBe("es");
    expect(validateFactLanguage("  FR ")).toBe("fr");
    expect(validateFactLanguage("ingles")).toBe("ingles");

    // 2-8 lowercase letters is the whole rule: "french" is legal, "fr4" is not
    for (const bad of ["e", "frenchness", "pt-BR", "fr4", "  "]) {
      try {
        validateFactLanguage(bad);
        throw new Error("expected failure");
      } catch (error) {
        expect((error as FactValidationError).field, bad).toBe("language");
      }
    }
  });

  it("accepts real calendar dates only, including the leap day of a leap year", () => {
    expect(isRealDate("2026-01-01")).toBe(true);
    expect(isRealDate("2024-02-29")).toBe(true);
    expect(isRealDate("2026-02-29")).toBe(false);
    expect(isRealDate("2026-04-31")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("2026-00-10")).toBe(false);
    expect(isRealDate("01/01/2026")).toBe(false);
    expect(isRealDate("2026-1-1")).toBe(false);
    expect(isRealDate("")).toBe(false);

    expect(validateEffectiveFrom("2026-12-31")).toBe("2026-12-31");
    try {
      validateEffectiveFrom("2026-02-30");
      throw new Error("expected failure");
    } catch (error) {
      expect((error as FactValidationError).field).toBe("effectiveFrom");
    }
    // seasonal facts may be future-dated: no "not in the future" rule
    expect(validateEffectiveFrom("2099-12-31")).toBe("2099-12-31");
    try {
      validateEffectiveFrom("soon", "on");
      throw new Error("expected failure");
    } catch (error) {
      expect((error as FactValidationError).field).toBe("on");
    }
  });

  it("accepts a UUID or explicit null for the source version, and preserves undefined", () => {
    const uuid = "1f0a2a3b-0003-4c01-a1a1-000000000003";
    expect(validateSourceArticleVersionId(uuid)).toBe(uuid);
    expect(validateSourceArticleVersionId(null)).toBeNull();
    expect(validateSourceArticleVersionId(undefined)).toBeUndefined();
    try {
      validateSourceArticleVersionId("not-a-uuid");
      throw new Error("expected failure");
    } catch (error) {
      expect((error as FactValidationError).field).toBe("sourceArticleVersionId");
    }
  });

  it("normalizes a whole fact and rejects a non-object", () => {
    expect(
      validateFactInput(
        input({ topicKey: "  pool.hours ", value: "  21:00 ", language: "ES" as string }),
      ),
    ).toEqual({
      topicKey: "pool.hours",
      factKey: "closing_time",
      value: "21:00",
      unit: "time-of-day",
      language: "es",
      effectiveFrom: "2026-01-01",
      sourceArticleVersionId: undefined,
    });
    expect(validateFactInput(input({ sourceArticleVersionId: null })).sourceArticleVersionId)
      .toBeNull();

    for (const bad of [null, "nope", 3]) {
      try {
        validateFactInput(bad as unknown as FactInput);
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(FactValidationError);
      }
    }
  });
});

describe("lookup is lookup, not generation (AC-1)", () => {
  const forbidden = [
    /\bINSERT\b/i,
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bMERGE\b/i,
    /\bembedding\b/i,
    /\bvector\b/i,
    /\bts_rank\b/i,
    /\bwebsearch_to_tsquery\b/i,
    /\bopenai\b/i,
    /\banthropic\b/i,
    /\bcompletion\b/i,
    /\bprompt\b/i,
    /\bmodel\b/i,
    /\bllm\b/i,
    /\bgenerate\b/i,
    /\bpgvector\b/i,
  ];

  it("is a single read over property_facts with no write clause", () => {
    expect(FACT_LOOKUP_SQL).toMatch(/\bSELECT\b/i);
    expect(FACT_LOOKUP_SQL).toMatch(/\bFROM property_facts\b/i);
    for (const pattern of forbidden) {
      expect(pattern.test(FACT_LOOKUP_SQL), pattern.source).toBe(false);
    }
  });

  it("hard-filters on verified, exact key and tenant, newest effective date first", () => {
    expect(FACT_LOOKUP_SQL).toMatch(/AND verified\b/);
    expect(FACT_LOOKUP_SQL).toMatch(/org_id = \$1/);
    expect(FACT_LOOKUP_SQL).toMatch(/AND property_id = \$2/);
    expect(FACT_LOOKUP_SQL).toMatch(/AND topic_key = \$3/);
    expect(FACT_LOOKUP_SQL).toMatch(/AND fact_key = \$4/);
    expect(FACT_LOOKUP_SQL).toMatch(/AND language = \$5/);
    expect(FACT_LOOKUP_SQL).toMatch(/effective_from <= COALESCE\(\$6::date, CURRENT_DATE\)/);
    expect(FACT_LOOKUP_SQL).toMatch(/ORDER BY effective_from DESC, created_at DESC/);
    expect(FACT_LOOKUP_SQL).toMatch(/LIMIT 1/);
    // unverified rows can never satisfy the filter - AC-2's "no guess"
    expect(FACT_LOOKUP_SQL).not.toMatch(/verified IS NOT TRUE|NOT verified\b/);
  });

  it("groups contradictions on the whole key, including a nullable effective date", () => {
    expect(FACT_CONTRADICTIONS_SQL).toMatch(/\bSELECT\b/i);
    for (const pattern of forbidden) {
      expect(pattern.test(FACT_CONTRADICTIONS_SQL), pattern.source).toBe(false);
    }
    expect(FACT_CONTRADICTIONS_SQL).toMatch(
      /GROUP BY 1, 2, 3, 4\s+HAVING count\(DISTINCT f\.fact_value\) > 1/,
    );
    expect(FACT_CONTRADICTIONS_SQL).toMatch(/IS NOT DISTINCT FROM/);
    expect(FACT_CONTRADICTIONS_SQL).toMatch(/f\.org_id = \$1/);
    expect(FACT_CONTRADICTIONS_SQL).toMatch(/f\.property_id = \$2/);
    // S04-01: a group a human has already resolved must leave the queue, or
    // "unresolved contradictions" can never reach zero (G1).
    expect(FACT_CONTRADICTIONS_SQL).toMatch(/NOT EXISTS \(/);
    expect(FACT_CONTRADICTIONS_SQL).toMatch(/FROM fact_resolutions r/);
    expect(FACT_CONTRADICTIONS_SQL).toMatch(
      /r\.effective_from IS NOT DISTINCT FROM f\.effective_from/,
    );
  });
});

describe("unit vocabulary", () => {
  it("matches the migration's closed CHECK exactly", () => {
    expect([...FACT_UNITS]).toEqual([
      "text",
      "time-of-day",
      "hours",
      "currency-amount",
      "duration",
      "distance",
      "count",
    ]);
  });
});

/** "Today" is a calendar day AT THE PROPERTY (P2), not at the database. */
describe("property timezone resolves today (P2)", () => {
  const instant = new Date("2026-10-26T02:00:00Z");

  it("counts the calendar day where the hotel is, not where the session runs", () => {
    expect(propertyLocalDate("America/Mexico_City", instant)).toBe("2026-10-25");
    expect(propertyLocalDate("UTC", instant)).toBe("2026-10-26");
    expect(propertyLocalDate("Asia/Tokyo", instant)).toBe("2026-10-26");
  });

  it("always returns a zero-padded YYYY-MM-DD the date accepts", () => {
    const formatted = propertyLocalDate("America/Mexico_City", instant);
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isRealDate(formatted ?? "")).toBe(true);
    // midnight local can still be the previous UTC day (winter, UTC-5)
    expect(propertyLocalDate("America/New_York", new Date("2026-01-15T02:00:00Z"))).toBe(
      "2026-01-14",
    );
  });

  it("returns null when there is nothing usable to resolve, so SQL falls back", () => {
    for (const zone of [null, undefined, "", "   "]) {
      expect(propertyLocalDate(zone, instant), String(zone)).toBeNull();
    }
    // Intl throws RangeError on an unknown zone; the caller must not crash
    expect(propertyLocalDate("Not/AZone", instant)).toBeNull();
  });
});

describe("lookup asks the property, then the verified rows", () => {
  const context = {
    orgId: "00000000-0000-0000-0000-0000000000a1",
    propertyId: "00000000-0000-0000-0000-0000000000b1",
  };
  const lookupInput = { topicKey: "pool.hours", factKey: "closing_time", language: "es" };

  function stubClient(...responses: { rows: Record<string, unknown>[] }[]) {
    const calls: { sql: string; params: unknown[] | undefined }[] = [];
    let index = 0;
    const client = {
      query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        const response = responses[index] ?? { rows: [] };
        index += 1;
        return Promise.resolve(response);
      },
    } as unknown as pg.Client;
    return { client, calls };
  }

  it("resolves the effective date from the property's timezone when no `on` is given", async () => {
    const { client, calls } = stubClient(
      { rows: [{ time_zone: "America/Mexico_City" }] },
      { rows: [{ fact_value: "21:00", unit: "time-of-day", effective_from: "2026-01-01" }] },
    );

    const hit = await lookupFact(
      client,
      context,
      lookupInput,
      new Date("2026-10-26T02:00:00Z"),
    );

    expect(hit).toEqual({ value: "21:00", unit: "time-of-day", effectiveFrom: "2026-01-01" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toMatch(/SELECT time_zone FROM properties/);
    expect(calls[0]!.params).toEqual([context.orgId, context.propertyId]);
    expect(calls[1]!.sql).toBe(FACT_LOOKUP_SQL);
    expect(calls[1]!.params).toEqual([
      context.orgId,
      context.propertyId,
      "pool.hours",
      "closing_time",
      "es",
      "2026-10-25",
    ]);
  });

  it("skips the timezone query when the caller already knows the date", async () => {
    const { client, calls } = stubClient({ rows: [] });

    expect(await lookupFact(client, context, { ...lookupInput, on: "2026-01-01" })).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(FACT_LOOKUP_SQL);
    expect(calls[0]!.params?.[5]).toBe("2026-01-01");
  });

  it("passes NULL when the timezone cannot be resolved, letting SQL use CURRENT_DATE", async () => {
    const { client, calls } = stubClient({ rows: [] }, { rows: [] });

    expect(await lookupFact(client, context, lookupInput)).toBeNull();
    expect(calls[1]!.params?.[5]).toBeNull();
  });
});
