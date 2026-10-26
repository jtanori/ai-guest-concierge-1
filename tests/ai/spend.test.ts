/**
 * S07-04 AC-2 — the estimator that feeds the cap.
 *
 * The direction of every rounding decision is the point of this file: the
 * estimate must never come out BELOW what the vendor will bill, because a cap
 * that under-counts silently overspends.
 */
import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  MODEL_PRICES,
  costUsd,
  estimateTokens,
  priceFor,
  utcDay,
  worstCasePrice,
} from "../../src/ai/spend.ts";

describe("estimateTokens", () => {
  it("rounds up, so a partial token is still a token", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("a".repeat(CHARS_PER_TOKEN))).toBe(1);
    expect(estimateTokens("a".repeat(CHARS_PER_TOKEN + 1))).toBe(2);
  });

  it("never returns zero, so an empty answer still costs an input", () => {
    expect(estimateTokens("")).toBeGreaterThan(0);
  });

  it("scales with length", () => {
    expect(estimateTokens("a".repeat(4_000))).toBe(1_000);
  });
});

describe("pricing", () => {
  it("prices the two pinned models (DEC-2)", () => {
    expect(Object.keys(MODEL_PRICES).sort()).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
    expect(priceFor("gemini-2.5-flash")).toBe(MODEL_PRICES["gemini-2.5-flash"]);
  });

  it("prices an unknown model at the worst known rate, never as free", () => {
    const worst = worstCasePrice();
    expect(priceFor("gemini-9-experimental")).toEqual(worst);
    expect(worst.inputPerMillion).toBeGreaterThan(0);
    expect(worst.outputPerMillion).toBeGreaterThan(0);
  });

  it("is output-heavy: output must cost more than input per token", () => {
    for (const price of Object.values(MODEL_PRICES)) {
      expect(price.outputPerMillion).toBeGreaterThan(price.inputPerMillion);
    }
  });
});

describe("costUsd", () => {
  it("matches the published arithmetic for a real-sized call", () => {
    // 1,000 prompt + 500 completion on flash: 0.0003 + 0.00125 = 0.00155
    expect(
      costUsd("gemini-2.5-flash", { promptTokens: 1_000, completionTokens: 500 }),
    ).toBeCloseTo(0.00155, 6);
  });

  it("rounds up to six decimals rather than down", () => {
    // 1 prompt token at 0.3/M = 0.0000003; rounding down would be zero, and a
    // zero-cost call would never trip a cap.
    const cost = costUsd("gemini-2.5-flash", { promptTokens: 1, completionTokens: 0 });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBe(0.000001);
  });

  it("is monotonic in both directions", () => {
    const base = costUsd("gemini-2.5-flash", { promptTokens: 1_000, completionTokens: 100 });
    expect(costUsd("gemini-2.5-flash", { promptTokens: 2_000, completionTokens: 100 })).toBeGreaterThan(base);
    expect(costUsd("gemini-2.5-flash", { promptTokens: 1_000, completionTokens: 200 })).toBeGreaterThan(base);
  });

  it("charges more for the expensive model than the lite one", () => {
    const usage = { promptTokens: 2_000, completionTokens: 400 };
    expect(costUsd("gemini-2.5-flash", usage)).toBeGreaterThan(costUsd("gemini-2.5-flash-lite", usage));
  });
});

describe("utcDay", () => {
  it("is the UTC calendar day, so the cap resets once globally", () => {
    expect(utcDay(new Date("2026-10-25T00:00:00.000Z"))).toBe("2026-10-25");
    expect(utcDay(new Date("2026-10-25T23:59:59.999Z"))).toBe("2026-10-25");
    // 18:00 in Sonora is the next UTC day; the counter follows UTC, not the
    // guest's clock, or two guests would trip different caps for one budget.
    expect(utcDay(new Date("2026-10-26T01:00:00.000Z"))).toBe("2026-10-26");
  });
});
