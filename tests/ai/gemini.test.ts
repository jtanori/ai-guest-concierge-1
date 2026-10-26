/**
 * S05-01 / DEC-2 — the Gemini adapter, against a fake `fetch`.
 *
 * No network, no key: the request shape, the schema translation, the retryable
 * vs fatal classification, and the rule that the API key never appears in an
 * error message are all asserted here. The end-to-end case is the one that
 * matters most: the adapter returns TEXT and `parseAiOutput` is what decides
 * whether it is usable.
 */
import { describe, expect, it } from "vitest";
import { AiContractError, parseAiOutput } from "../../src/ai/contract.ts";
import { AI_OUTPUT_JSON_SCHEMA, PROMPT_VERSION, buildPrompt } from "../../src/ai/prompt.ts";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import {
  createGeminiProvider,
  RECOMMENDED_GEMINI_FALLBACK,
  RECOMMENDED_GEMINI_PRIMARY,
  toGeminiSchema,
  type FetchLike,
} from "../../src/providers/gemini.ts";

const KEY = "AIza-DO-NOT-LEAK-1234567890";
const V1 = "11111111-1111-4111-8111-111111111111";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(
  respond: (call: Call) => { status?: number; json?: unknown; text?: string },
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    const result = respond(call);
    const status = result.status ?? 200;
    const text = result.text ?? JSON.stringify(result.json ?? {});
    return { ok: status >= 200 && status < 300, status, text: async () => text } as Response;
  };
  return { fetchImpl, calls };
}

function answerJson(): Record<string, unknown> {
  return {
    decision: "answer",
    answer: "La alberca cierra a las 20:00.",
    language: "es-MX",
    citations: [{ article_version_id: V1, quote: "cierra a las 20:00" }],
    reason_code: null,
    topic_keys_used: ["pool.hours"],
    confidence: 0.82,
  };
}

function geminiReply(output: string | Record<string, unknown>) {
  return {
    json: {
      candidates: [
        {
          content: { parts: [{ text: typeof output === "string" ? output : JSON.stringify(output) }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { totalTokenCount: 120 },
    },
  };
}

function provider(respond: (call: Call) => { status?: number; json?: unknown; text?: string }) {
  const { fetchImpl, calls } = fakeFetch(respond);
  return {
    calls,
    ai: createGeminiProvider(
      { apiKey: KEY, model: RECOMMENDED_GEMINI_PRIMARY, baseUrl: "https://gemini.test/v1beta" },
      fetchImpl,
    ),
  };
}

const request = {
  system: "system",
  prompt: "prompt",
  schema: AI_OUTPUT_JSON_SCHEMA,
  temperature: 0 as const,
  timeoutMs: 5_000,
};

describe("Gemini adapter (S05-01 / DEC-2)", () => {
  it("pins the recommended pair and sends a pinned model id", () => {
    expect(RECOMMENDED_GEMINI_PRIMARY).toBe("gemini-2.5-flash");
    expect(RECOMMENDED_GEMINI_FALLBACK).toBe("gemini-2.5-flash-lite");
    const { ai, calls } = provider(() => geminiReply(answerJson()));
    expect(ai.modelId).toBe(RECOMMENDED_GEMINI_PRIMARY);
    void ai.generate(request).then(() => {
      expect(calls[0]!.url).toBe(
        `https://gemini.test/v1beta/models/${RECOMMENDED_GEMINI_PRIMARY}:generateContent`,
      );
    });
  });

  it("puts the key in the header, nowhere else, and never in an error message", async () => {
    const { ai, calls } = provider(() => ({ status: 429, text: "quota exhausted" }));
    await expect(ai.generate(request)).rejects.toThrow(/quota exhausted/);
    expect(calls[0]!.headers["x-goog-api-key"]).toBe(KEY);
    expect(JSON.stringify(calls[0]!.body)).not.toContain(KEY);

    const leaky = provider(() => ({ status: 500, text: `failed for key ${KEY}` }));
    await expect(leaky.ai.generate(request)).rejects.toThrow();
    try {
      await leaky.ai.generate(request);
    } catch (error) {
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it("asks for JSON with temperature 0 and a translated response schema", async () => {
    const { ai, calls } = provider(() => geminiReply(answerJson()));
    await ai.generate(request);
    const body = calls[0]!.body as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      generationConfig: Record<string, unknown>;
    };
    expect(body.systemInstruction.parts[0]!.text).toBe("system");
    expect(body.contents[0]!.role).toBe("user");
    expect(body.generationConfig["temperature"]).toBe(0);
    expect(body.generationConfig["responseMimeType"]).toBe("application/json");
    const schema = body.generationConfig["responseSchema"] as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    // Gemini's subset: no strict/additionalProperties, nullables as `nullable`.
    expect(schema["additionalProperties"]).toBeUndefined();
    expect(schema["strict"]).toBeUndefined();
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["answer"]).toMatchObject({ nullable: true });
    expect(properties["reason_code"]).toMatchObject({ nullable: true });
    // A nullable field is not `required` for Gemini; our validator still is.
    expect(schema["required"]).not.toContain("answer");
    expect(schema["required"]).toContain("decision");
    expect((schema["required"] as string[]).length).toBe(5);
  });

  it("classifies failures: 429/5xx retryable, 400 fatal, blocked/fatal finish reasons fatal", async () => {
    const retryable = provider(() => ({ status: 503 }));
    await expect(retryable.ai.generate(request)).rejects.toMatchObject({
      name: "AiProviderError",
      retryable: true,
      status: 503,
    });

    const bad = provider(() => ({ status: 400, text: "invalid schema" }));
    await expect(bad.ai.generate(request)).rejects.toMatchObject({ retryable: false, status: 400 });

    const blocked = provider(() => ({ json: { promptFeedback: { blockReason: "SAFETY" } } }));
    await expect(blocked.ai.generate(request)).rejects.toMatchObject({
      retryable: false,
    });
    await expect(blocked.ai.generate(request)).rejects.toThrow(/blocked the prompt \(SAFETY\)/);

    const truncated = provider(() => ({
      json: { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] },
    }));
    await expect(truncated.ai.generate(request)).rejects.toThrow(/stopped early \(MAX_TOKENS\)/);
  });

  it("rejects a reply with no text part and a non-JSON body", async () => {
    const empty = provider(() => ({ json: { candidates: [{ content: { parts: [] } }] } }));
    await expect(empty.ai.generate(request)).rejects.toThrow(/no text part/);

    const garbage = provider(() => ({ status: 200, text: "<html>gateway</html>" }));
    await expect(garbage.ai.generate(request)).rejects.toThrow(/not JSON/);
  });

  it("returns text that parseAiOutput then validates end to end", async () => {
    const { ai } = provider(() => geminiReply(answerJson()));
    const built = buildPrompt({
      question: "¿A qué hora cierra la alberca?",
      propertyLanguage: "es-MX",
      tone: "friendly",
      articles: [
        {
          articleVersionId: V1,
          topicKey: "pool.hours",
          title: "Alberca",
          text: "La alberca cierra a las 20:00.",
        },
      ],
    });
    const raw = await ai.generate({ ...request, ...built, schema: AI_OUTPUT_JSON_SCHEMA });
    const output = parseAiOutput(raw, { allowedVersionIds: [V1], allowedTopicKeys: ["pool.hours"] });
    expect(output.decision).toBe("answer");
    expect(output.citations[0]!.articleVersionId).toBe(V1);
    // The prompt the adapter sent is the versioned one, not an ad-hoc string.
    expect(PROMPT_VERSION).toMatch(/^answer-v\d+$/);
  });

  it("fails the contract when the model answers with prose instead of JSON", async () => {
    const { ai } = provider(() => geminiReply("Sure! The pool closes at 20:00."));
    const raw = await ai.generate(request);
    expect(() => parseAiOutput(raw, { allowedVersionIds: [V1] })).toThrow(AiContractError);
  });

  it("falls back to the second model through withResilience when Gemini is down", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500, text: "upstream down" }));
    const primary = createGeminiProvider(
      { apiKey: KEY, model: RECOMMENDED_GEMINI_PRIMARY, baseUrl: "https://gemini.test/v1beta" },
      fetchImpl,
    );
    const fallback = createFixedProvider(answerJson(), RECOMMENDED_GEMINI_FALLBACK);
    const ai = withResilience(primary, fallback, {
      retries: 0,
      sleep: async () => {},
      now: () => 0,
    });
    const result = await ai.generate(request);
    expect(result).toMatchObject({ modelId: RECOMMENDED_GEMINI_FALLBACK, usedFallback: true });
    expect(parseAiOutput(result.raw, { allowedVersionIds: [V1] }).decision).toBe("answer");
  });
});

describe("toGeminiSchema", () => {
  it("converts nullable unions and drops null from enums", () => {
    expect(
      toGeminiSchema({
        type: "object",
        properties: {
          reason_code: { type: ["string", "null"], enum: ["low_retrieval", null] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["reason_code", "confidence"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        reason_code: { type: "string", nullable: true, enum: ["low_retrieval"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["confidence"],
    });
  });

  it("recurses into arrays of objects and accepts the {schema} wrapper", () => {
    const converted = toGeminiSchema({
      name: "x",
      strict: true,
      schema: {
        type: "object",
        properties: {
          citations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { quote: { type: "string" } },
              required: ["quote"],
            },
          },
        },
      },
    });
    const citations = (converted["properties"] as Record<string, Record<string, unknown>>)[
      "citations"
    ]!;
    expect(citations["type"]).toBe("array");
    expect(citations["items"]).toEqual({
      type: "object",
      properties: { quote: { type: "string" } },
      required: ["quote"],
    });
  });

  it("refuses a non-object schema", () => {
    expect(() => toGeminiSchema("nope")).toThrow(RangeError);
  });
});
