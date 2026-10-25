import { describe, expect, it } from "vitest";
import {
  assertEmbeddingDimension,
  EMBEDDING_DIMENSIONS,
  EmbeddingDimensionError,
  toVectorLiteral,
} from "../../src/knowledge/embedding.ts";

function validEmbedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index % 17) / 17);
}

describe("embedding validator", () => {
  it("accepts exactly 1536 finite floats", () => {
    const vector = validEmbedding();
    expect(() => assertEmbeddingDimension(vector)).not.toThrow();
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("rejects a 1535-dimension vector", () => {
    expect(() => assertEmbeddingDimension(validEmbedding().slice(1))).toThrow(
      EmbeddingDimensionError,
    );
  });

  it("rejects NaN and Infinity", () => {
    const withNaN = validEmbedding();
    withNaN[42] = Number.NaN;
    expect(() => assertEmbeddingDimension(withNaN)).toThrow(EmbeddingDimensionError);

    const withInfinity = validEmbedding();
    withInfinity[0] = Number.POSITIVE_INFINITY;
    expect(() => assertEmbeddingDimension(withInfinity)).toThrow(EmbeddingDimensionError);
  });

  it("rejects non-arrays", () => {
    expect(() => assertEmbeddingDimension("not an array")).toThrow(EmbeddingDimensionError);
    expect(() => assertEmbeddingDimension(new Float32Array(EMBEDDING_DIMENSIONS))).toThrow(
      EmbeddingDimensionError,
    );
  });

  it("renders the pgvector text literal", () => {
    expect(toVectorLiteral([0.5, -1, 2])).toBe("[0.5,-1,2]");
  });
});
