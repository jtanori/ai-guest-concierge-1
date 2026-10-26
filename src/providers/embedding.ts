/**
 * S04-02 / DEC-3 — the embedding provider, behind one seam.
 *
 * DEC-3 was answered by the operator: OpenAI `text-embedding-3-small` (1536
 * dimensions, which D3 locks), reached over plain `fetch` — no SDK, so no new
 * runtime dependency and no supply chain for something this small. The
 * interface is deliberately provider-shaped, not OpenAI-shaped: swapping the
 * adapter is a one-file change, and `EMBEDDING_BASE_URL` already allows a
 * gateway or a self-hosted endpoint.
 *
 * Three rules this file exists to enforce:
 *
 *  1. A vector that is not 1536 finite numbers never leaves this module —
 *     `assertEmbeddingDimension` runs on every vector, in input order, before
 *     the caller can write it. A provider that changes width under us is a
 *     loud failure, not a silent truncation by Postgres.
 *  2. The API key is never echoed. Errors carry a status and a short body
 *     snippet only; the request headers (the only place the key appears) are
 *     never formatted into a message, and `ConfigError` from
 *     `loadEmbeddingConfig` names the VARIABLE, not its value.
 *  3. Order is the contract. The provider returns an `index` per item; we sort
 *     by it and verify it is a permutation of 0..n-1, so chunk N can never
 *     receive chunk M's vector.
 */
import {
  loadEmbeddingConfig,
  type EmbeddingConfig,
} from "../config/env.ts";
import {
  assertEmbeddingDimension,
  EmbeddingDimensionError,
} from "../knowledge/embedding.ts";

export { EmbeddingDimensionError };

export interface EmbeddingProvider {
  /** Returns one vector per input text, in the same order. */
  embed(texts: readonly string[]): Promise<number[][]>;
  readonly model: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class EmbeddingProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.status = status;
  }
}

interface ProviderResponse {
  data?: unknown;
  error?: unknown;
}

/** Cap on how much of a provider's error body reaches a log line. */
const SNIPPET_LIMIT = 300;

function snippet(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length <= SNIPPET_LIMIT ? collapsed : `${collapsed.slice(0, SNIPPET_LIMIT)}…`;
}

function describeProviderError(payload: ProviderResponse): string {
  const error = payload.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return snippet(message);
  }
  if (typeof error === "string" && error.trim() !== "") return snippet(error);
  return "provider returned an error";
}

/**
 * Parses `{ data: [{ index, embedding }] }`, refusing anything that cannot be
 * mapped back to the exact input positions.
 */
function parseVectors(payload: unknown, expected: number): number[][] {
  if (typeof payload !== "object" || payload === null) {
    throw new EmbeddingProviderError("provider response was not a JSON object");
  }
  const data = (payload as ProviderResponse).data;
  if (!Array.isArray(data)) {
    throw new EmbeddingProviderError("provider response is missing a `data` array");
  }
  if (data.length !== expected) {
    throw new EmbeddingProviderError(
      `provider returned ${data.length} embeddings for ${expected} inputs`,
    );
  }

  const ordered: number[][] = new Array<number[]>(expected);
  const seen = new Set<number>();
  for (const [position, item] of data.entries()) {
    if (typeof item !== "object" || item === null) {
      throw new EmbeddingProviderError("provider returned a non-object embedding entry");
    }
    const rawIndex = (item as { index?: unknown }).index;
    // Some compatible providers omit `index` when there is one item per call;
    // an explicit index must still be a valid position.
    const index = rawIndex === undefined ? position : Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= expected) {
      throw new EmbeddingProviderError(
        `provider returned index ${String(rawIndex)} outside 0..${expected - 1}`,
      );
    }
    if (seen.has(index)) {
      throw new EmbeddingProviderError(`provider returned index ${index} twice`);
    }
    seen.add(index);

    const vector = (item as { embedding?: unknown }).embedding;
    // Throws EmbeddingDimensionError, which is NOT an EmbeddingProviderError:
    // the payload was well-formed, the model just disagrees with the schema.
    assertEmbeddingDimension(vector);
    ordered[index] = vector;
  }
  return ordered;
}

/** Splits `texts` into batches small enough for one request. */
function batches(texts: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let start = 0; start < texts.length; start += size) {
    out.push(texts.slice(start, start + size));
  }
  return out;
}

export function createEmbeddingProvider(
  config: EmbeddingConfig,
  fetchImpl: FetchLike = fetch,
): EmbeddingProvider {
  const url = `${config.baseUrl}/embeddings`;

  async function embedBatch(batch: readonly string[]): Promise<number[][]> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, input: batch, encoding_format: "float" }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      // Never re-throw the raw error: a fetch rejection can carry the request
      // (and therefore the Authorization header) in its message.
      const reason = error instanceof Error ? error.name : "unknown error";
      throw new EmbeddingProviderError(`embedding provider request failed (${reason})`);
    }

    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      throw new EmbeddingProviderError(
        `embedding provider responded ${response.status}: ${snippet(raw) || "no body"}`,
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new EmbeddingProviderError("embedding provider response was not JSON", response.status);
    }

    const payload = parsed as ProviderResponse;
    if (payload.error !== undefined && payload.data === undefined) {
      throw new EmbeddingProviderError(describeProviderError(payload), response.status);
    }
    return parseVectors(parsed, batch.length);
  }

  return {
    model: config.model,
    async embed(texts: readonly string[]): Promise<number[][]> {
      if (!Array.isArray(texts) || texts.length === 0) {
        throw new EmbeddingProviderError("embed() needs at least one text");
      }
      for (const text of texts) {
        if (typeof text !== "string" || text.trim() === "") {
          throw new EmbeddingProviderError("embed() refuses blank text");
        }
      }

      const vectors: number[][] = [];
      for (const batch of batches(texts, config.batchSize)) {
        vectors.push(...(await embedBatch(batch)));
      }
      return vectors;
    },
  };
}

/** The production wiring: config from the environment, `fetch` from the runtime. */
export function embeddingProviderFromEnv(
  source: Record<string, string | undefined>,
  fetchImpl: FetchLike = fetch,
): EmbeddingProvider {
  return createEmbeddingProvider(loadEmbeddingConfig(source), fetchImpl);
}
