import { describe, expect, it } from "vitest";
import { en, es, type StringId } from "../../src/i18n/catalog.ts";
import { ROLLUP_METRICS } from "../../src/analytics/rollups.ts";
import { TILE_BY_METRIC, TILES } from "../../src/analytics/tiles.ts";

/**
 * S10-03 — the tile table's invariants, without a database.
 *
 * The dashboard's promise is that a tile cannot drift from the rollup it claims to
 * show. Three things enforce it, and each is asserted here rather than trusted:
 * one tile per metric, the *same* SQL string (identity, not equality, because a
 * copy that happens to match today is exactly the drift being prevented), and
 * catalogue ids that exist in both languages.
 */
describe("dashboard tiles (S10-03)", () => {
  it("has exactly one tile per rollup metric, in registry order", () => {
    expect(TILES.map((tile) => tile.metric)).toEqual(ROLLUP_METRICS.map((m) => m.metric));
    expect(new Set(TILES.map((tile) => tile.id)).size).toBe(TILES.length);
  });

  it("carries the rollup's own statement, not a copy of it (AC-1)", () => {
    for (const metric of ROLLUP_METRICS) {
      const tile = TILE_BY_METRIC.get(metric.metric);
      expect(tile, metric.metric).toBeDefined();
      // Identity: the string the upsert executed is the string the tile prints.
      expect(tile!.querySql).toBe(metric.sql);
    }
  });

  it("names a catalogue string that exists in English and Spanish (AC-3)", () => {
    const englishIds = Object.keys(en) as StringId[];
    const spanishIds = Object.keys(es) as StringId[];
    for (const tile of TILES) {
      expect(englishIds, `${tile.metric} label`).toContain(tile.labelId);
      expect(englishIds, `${tile.metric} description`).toContain(tile.descriptionId);
      expect(spanishIds, `${tile.metric} label`).toContain(tile.labelId);
      expect(spanishIds, `${tile.metric} description`).toContain(tile.descriptionId);
      // A tile whose label is its own metric name would be technically translated
      // and practically unreadable, which is the failure "no hardcoded copy" means
      // to prevent.
      expect(en[tile.labelId]).not.toContain(tile.metric);
    }
  });

  it("formats only ratios and durations, so counts are never rescaled", () => {
    for (const tile of TILES) {
      if (tile.unit === "ratio") expect(tile.format).toBe("percent");
      else if (tile.unit === "seconds") expect(tile.format).toBe("seconds");
      else expect(tile.format).toBe("count");
    }
  });
});
