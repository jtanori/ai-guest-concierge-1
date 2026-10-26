/**
 * S04-02 / DEC-3 — the embedding provider seam.
 *
 * No network: a fake `fetch` proves the request shape, the ordering contract,
 * the dimension guard and — the one that matters most — that the API key never
 * appears in an error message.
 */
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_EMBEDDING_MODEL,
  loadEmbeddingConfig,
} from "../../src/config/env.ts";
import { EMBEDDING_DIMENSIONS, EmbeddingDimensionError } from "../../src/knowledge/embedding.ts";
import {
  createEmbeddingProvider,
  EmbeddingProviderError,
  embeddingProviderFromEnv,
  type FetchLike,
} from "../../src/providers/embedding.ts";

const KEY = "sk-test-DO-NOT-LEAK-1234567890";

function config(overrides: Partial<Parameters<typeof createEmbeddingProvider>[0]> = {}) {
  return {
    apiKey: KEY,
    model: "text-embedding-3-small",
    baseUrl: "https://embeddings.test/v1",
    timeoutMs: 5_000,
    batchSize: 16,
    ...overrides,
  };
}

function vector(seed = 0, dims = EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: dims }, (_, index) => ((index + seed) % 7) / 7);
}

interface Call {
  url: string;
  body: { model?: string; input?: string[] };
  headers: Record<string, string>;
}

function fakeFetch(
  respond: (call: Call) => { status?: number; json?: unknown; text?: string } | Promise<never>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Call["body"];
    const call: Call = { url, body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const result = await respond(call);
    const status = result.status ?? 200;
    const text = result.text ?? JSON.stringify(result.json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  };
  return { fetchImpl, calls };
}

function okResponse(call: Call, reverse = false): { json: unknown } {
  const input = call.body.input ?? [];
  const data = input.map((_, index) => ({ index, embedding: vector(index) }));
  return { json: { data: reverse ? [...data].reverse() : data } };
}

describe("embedding config (S04-02 / DEC-3)", () => {
  it("refuses to start without a key, and names the variable not a value", () => {
    expect(() => loadEmbeddingConfig({})).toThrow(ConfigError);
    expect(() => loadEmbeddingConfig({})).toThrow(/EMBEDDING_API_KEY/);
  });

  it("defaults the model to the one that emits 1536 dimensions", () => {
    const loaded = loadEmbeddingConfig({ EMBEDDING_API_KEY: KEY });
    expect(loaded.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(loaded.baseUrl).toBe("https://api.openai.com/v1");
    expect(loaded.batchSize).toBe(16);
  });

  it("normalises a trailing slash on the base URL", () => {
    expect(
      loadEmbeddingConfig({ EMBEDDING_API_KEY: KEY, EMBEDDING_BASE_URL: "https://gw.test/v1//" })
        .baseUrl,
    ).toBe("https://gw.test/v1");
  });

  it("rejects a base URL that is not http(s) and a non-positive timeout", () => {
    expect(() =>
      loadEmbeddingConfig({ EMBEDDING_API_KEY: KEY, EMBEDDING_BASE_URL: "file:///etc/passwd" }),
    ).toThrow(/http\(s\)/);
    expect(() =>
      loadEmbeddingConfig({ EMBEDDING_API_KEY: KEY, EMBEDDING_TIMEOUT_MS: "0" }),
    ).toThrow(/EMBEDDING_TIMEOUT_MS/);
    expect(() =>
      loadEmbeddingConfig({ EMBEDDING_API_KEY: KEY, EMBEDDING_BATCH_SIZE: "999" }),
    ).toThrow(/EMBEDDING_BATCH_SIZE/);
  });

  it("wires the provider from the environment", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => okResponse(call));
    const provider = embeddingProviderFromEnv({ EMBEDDING_API_KEY: KEY }, fetchImpl);
    await provider.embed(["hola"]);
    expect(provider.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(calls).toHaveLength(1);
  });
});

describe("embedding provider (S04-02)", () => {
  it("posts to /embeddings with the model, the batch and the bearer key", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => okResponse(call));
    const provider = createEmbeddingProvider(config(), fetchImpl);

    await provider.embed(["first text", "second text"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://embeddings.test/v1/embeddings");
    expect(calls[0]!.body.model).toBe("text-embedding-3-small");
    expect(calls[0]!.body.input).toEqual(["first text", "second text"]);
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("returns vectors in INPUT order even when the provider answers reversed", async () => {
    const { fetchImpl } = fakeFetch((call) => okResponse(call, true));
    const provider = createEmbeddingProvider(config(), fetchImpl);
    const vectors = await provider.embed(["a", "b", "c"]);
    expect(vectors.map((v) => v[0])).toEqual([0, 1 / 7, 2 / 7]);
  });

  it("splits by batchSize and concatenates in order", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => okResponse(call));
    const provider = createEmbeddingProvider(config({ batchSize: 2 }), fetchImpl);
    const vectors = await provider.embed(["a", "b", "c"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.input).toEqual(["c"]);
    expect(vectors).toHaveLength(3);
  });

  it("refuses a vector that is not 1536 finite numbers", async () => {
    const short = fakeFetch((call) => ({
      json: { data: (call.body.input ?? []).map((_, i) => ({ index: i, embedding: [0, 1] })) },
    }));
    await expect(createEmbeddingProvider(config(), short.fetchImpl).embed(["x"])).rejects.toThrow(
      EmbeddingDimensionError,
    );

    const nan = fakeFetch((call) => {
      const bad = vector();
      bad[10] = Number.NaN;
      return { json: { data: (call.body.input ?? []).map((_, i) => ({ index: i, embedding: bad })) } };
    });
    await expect(createEmbeddingProvider(config(), nan.fetchImpl).embed(["x"])).rejects.toThrow(
      /finite numbers/,
    );
  });

  it("refuses a wrong count, a duplicate index and an out-of-range index", async () => {
    const wrongCount = fakeFetch(() => ({ json: { data: [] } }));
    await expect(
      createEmbeddingProvider(config(), wrongCount.fetchImpl).embed(["x"]),
    ).rejects.toThrow(/0 embeddings for 1 inputs/);

    const duplicate = fakeFetch(() => ({
      json: { data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] },
    }));
    await expect(
      createEmbeddingProvider(config(), duplicate.fetchImpl).embed(["x", "y"]),
    ).rejects.toThrow(/twice/);

    const outOfRange = fakeFetch(() => ({
      json: { data: [{ index: 5, embedding: vector() }] },
    }));
    await expect(
      createEmbeddingProvider(config(), outOfRange.fetchImpl).embed(["x"]),
    ).rejects.toThrow(/outside 0\.\.0/);
  });

  it("maps a provider error response to a status, and never echoes the key", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 429,
      text: JSON.stringify({ error: { message: "rate limited, slow down" } }),
    }));
    const provider = createEmbeddingProvider(config(), fetchImpl);
    const failure = await provider.embed(["x"]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmbeddingProviderError);
    expect((failure as EmbeddingProviderError).status).toBe(429);
    expect((failure as Error).message).toContain("rate limited");
    expect((failure as Error).message).not.toContain(KEY);
  });

  it("maps a transport failure without re-throwing the request", async () => {
    const fetchImpl: FetchLike = async () => {
      // A realistic fetch rejection can carry the request in the message.
      throw new Error(`request to https://embeddings.test failed, headers={authorization: Bearer ${KEY}}`);
    };
    const failure = await createEmbeddingProvider(config(), fetchImpl)
      .embed(["x"])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmbeddingProviderError);
    expect((failure as Error).message).toMatch(/request failed/);
    expect((failure as Error).message).not.toContain(KEY);
  });

  it("refuses blank input instead of paying for a call", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => okResponse(call));
    const provider = createEmbeddingProvider(config(), fetchImpl);
    await expect(provider.embed([])).rejects.toThrow(/at least one text/);
    await expect(provider.embed(["   "])).rejects.toThrow(/blank/);
    expect(calls).toHaveLength(0);
  });
});
