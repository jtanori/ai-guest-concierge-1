/**
 * S11-05 — the three invariants, and the message an operator gets when one fails.
 *
 * Pure: `describeViolations` is the only thing between a failing nightly job and
 * whoever is paged, and "reconcile failed" sends that person to the wrong place.
 */
import { describe, expect, it } from "vitest";
import {
  EMBEDDING_INVARIANTS,
  describeViolations,
  type EmbeddingReconcileResult,
} from "../../src/knowledge/reconcile.ts";

function result(overrides: Partial<EmbeddingReconcileResult> = {}): EmbeddingReconcileResult {
  return {
    propertyId: "11111111-1111-5111-a111-111111111111",
    violations: [],
    ok: true,
    byInvariant: {
      current_version_without_chunks: 0,
      chunk_on_non_current_version: 0,
      chunk_without_parent_version: 0,
    },
    ...overrides,
  };
}

describe("embedding invariants", () => {
  it("names exactly the three the charter describes, in reporting order", () => {
    expect(EMBEDDING_INVARIANTS).toEqual([
      "current_version_without_chunks",
      "chunk_on_non_current_version",
      "chunk_without_parent_version",
    ]);
  });

  it("says a clean property is clean, without inventing work", () => {
    expect(describeViolations(result(), "casa-maya")).toBe("casa-maya: all three invariants hold");
  });

  it("names the invariant, the chunk and the version — never just 'failed'", () => {
    const message = describeViolations(
      result({
        ok: false,
        byInvariant: {
          current_version_without_chunks: 0,
          chunk_on_non_current_version: 1,
          chunk_without_parent_version: 0,
        },
        violations: [
          {
            invariant: "chunk_on_non_current_version",
            articleVersionId: "22222222-2222-5222-a222-222222222222",
            chunkId: "33333333-3333-5333-a333-333333333333",
          },
        ],
      }),
      "casa-maya",
    );
    expect(message).toBe(
      "casa-maya: chunk_on_non_current_version " +
        "(chunk 33333333-3333-5333-a333-333333333333 → " +
        "article_version 22222222-2222-5222-a222-222222222222)",
    );
  });

  it("renders an orphan without a chunk id as a version, not as 'chunk null'", () => {
    const message = describeViolations(
      result({
        ok: false,
        byInvariant: {
          current_version_without_chunks: 1,
          chunk_on_non_current_version: 0,
          chunk_without_parent_version: 0,
        },
        violations: [
          {
            invariant: "current_version_without_chunks",
            articleVersionId: "44444444-4444-5444-a444-444444444444",
            chunkId: null,
          },
        ],
      }),
      "hotel-sol",
    );
    expect(message).toBe(
      "hotel-sol: current_version_without_chunks " +
        "(article_version 44444444-4444-5444-a444-444444444444)",
    );
    expect(message).not.toContain("null");
  });
});
