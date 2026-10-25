import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { stableUuid } from "../../src/seed/ids.ts";

const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("seed contract (S02-04)", () => {
  it("derives deterministic RFC 4122 v5 UUIDs from stable keys", () => {
    expect(stableUuid("org:demo")).toBe(stableUuid("org:demo"));
    expect(stableUuid("org:demo")).toMatch(UUID_V5);
    expect(stableUuid("org:demo")).not.toBe(stableUuid("property:demo"));
    expect(stableUuid("")).toMatch(UUID_V5);
  });

  it("produces deterministic, normalized 1536-dimensional stub embeddings", () => {
    const first = stubEmbedding("Casa Mesa");
    const second = stubEmbedding("Casa Mesa");
    expect(first).toHaveLength(1536);
    expect(first).toEqual(second);
    expect(first).not.toEqual(stubEmbedding("Casa Mesa "));
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("wires db:seed and the literal make seed target", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["db:seed"]).toBe(
      "node --experimental-strip-types scripts/seed.ts",
    );

    const makefile = readFileSync("Makefile", "utf8");
    expect(makefile).toMatch(/^\.PHONY: seed$/m);
    expect(makefile).toMatch(/^seed:\s*$/m);
    expect(makefile).toMatch(/npm run db:seed/);
  });
});
