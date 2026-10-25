/**
 * S02-05 - embedding shape validation shared by retrieval and re-embed.
 *
 * The schema fixes vector(1536); a provider response with any other shape
 * must fail before it reaches Postgres. `Infinity`/`NaN` are rejected too:
 * pgvector accepts neither, and a silent conversion would hide a bad provider
 * response behind a database error.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export class EmbeddingDimensionError extends Error {
  constructor(message = `embedding must be an array of ${EMBEDDING_DIMENSIONS} finite numbers`) {
    super(message);
    this.name = "EmbeddingDimensionError";
  }
}

export function assertEmbeddingDimension(vector: unknown): asserts vector is number[] {
  if (!Array.isArray(vector)) {
    throw new EmbeddingDimensionError(`embedding must be an array, got ${typeof vector}`);
  }
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingDimensionError(
      `embedding must have ${EMBEDDING_DIMENSIONS} dimensions, got ${vector.length}`,
    );
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbeddingDimensionError("embedding values must be finite numbers");
    }
  }
}

/** pgvector accepts a text literal; a JS array would be sent as a Postgres array. */
export function toVectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}
