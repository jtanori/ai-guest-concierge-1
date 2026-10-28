/**
 * S05-01 / DEC-2 — Google Gemini adapter behind the provider seam.
 *
 * DEC-2 was answered "google gemini". The adapter is provider-shaped (it
 * implements `AiProvider`) so the retry/circuit policy in `provider.ts` stays
 * vendor-neutral, and the transport here has three jobs:
 *
 *  1. **Ask for JSON natively, and accept that it is not a guarantee.** Gemini's
 *     structured output is `responseMimeType: "application/json"` plus a
 *     `responseSchema` in an OpenAPI *subset*. The schema we hand it is
 *     translated below, and the reply is returned as TEXT — validation is
 *     `parseAiOutput`'s job, never this file's. A vendor that silently degrades
 *     the schema cannot get past the server-side check.
 *  2. **Never leak the key.** It travels in `x-goog-api-key` and nowhere else;
 *     errors carry a status and a short body snippet, because a transport throw
 *     can otherwise carry request headers into a log line.
 *  3. **Name the failure precisely enough to retry it.** 429/5xx/408 are
 *     retryable; a blocked or truncated candidate is not — retrying a safety
 *     block or a MAX_TOKENS cut repeats it.
 */
import type { AiProvider, AiRequest } from "../ai/provider.ts";
import { AiProviderError } from "../ai/provider.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * DEC-2's pair, swapped 2026-10-28 when Google retired the 2.5 ids (404 "no
 * longer available"); both replacements were verified against the live API
 * before the swap. Still passed in explicitly, never defaulted here.
 */
export const RECOMMENDED_GEMINI_PRIMARY = "gemini-3.6-flash";
export const RECOMMENDED_GEMINI_FALLBACK = "gemini-3.5-flash-lite";

const SNIPPET_LIMIT = 300;
const MAX_OUTPUT_TOKENS = 1024;

/** A finish reason that will repeat if retried, so it is not worth a retry. */
const FATAL_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MAX_TOKENS",
  "MALFORMED_FUNCTION_CALL",
]);

/**
 * Some gateways echo the request — headers included — back in the error body.
 * The key therefore has to be scrubbed from EVERY string that can reach a log
 * or an exception, not merely kept out of the request shape.
 */
function redact(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("[redacted]");
}

function snippet(raw: string, secret: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const safe = redact(collapsed, secret);
  return safe.length <= SNIPPET_LIMIT ? safe : `${safe.slice(0, SNIPPET_LIMIT)}…`;
}

/**
 * Translates the JSON-Schema we validate against into the subset Gemini's
 * `responseSchema` accepts.
 *
 * Two conversions are load-bearing:
 *
 *  - **Nullable unions.** Gemini has no `type: ["string", "null"]`. It has
 *    `nullable: true`, so `["string","null"]` becomes `{type:"string", nullable:true}`.
 *    Without this the two nullable fields of the contract (`answer`,
 *    `reason_code`) make the whole request a 400.
 *  - **No null in `enum`.** `enum: [...codes, null]` is rejected; the null case
 *    is expressed by `nullable` plus the field being absent from `required`.
 *
 * `additionalProperties` and `strict` are dropped: Gemini neither needs nor
 * understands them, and the validator is what enforces the closed shape.
 */
export function toGeminiSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new RangeError("response schema must be a JSON object");
  }
  // Accept both a bare schema and the `{name, strict, schema}` wrapper.
  const root =
    typeof (schema as { schema?: unknown }).schema === "object"
      ? (schema as { schema: Record<string, unknown> }).schema
      : (schema as Record<string, unknown>);
  return convert(root);
}

const PASSTHROUGH = ["description", "title", "format", "minimum", "maximum", "minItems", "maxItems"] as const;

function convert(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const rawType = node["type"];
  let nullable = node["nullable"] === true;
  let type: string | undefined;
  if (Array.isArray(rawType)) {
    const types = rawType.filter((entry): entry is string => typeof entry === "string");
    if (types.includes("null")) nullable = true;
    type = types.find((entry) => entry !== "null");
  } else if (typeof rawType === "string") {
    type = rawType;
  }
  if (type !== undefined) out["type"] = type;
  if (nullable) out["nullable"] = true;

  const rawEnum = node["enum"];
  if (Array.isArray(rawEnum)) {
    const values = rawEnum.filter((entry) => entry !== null);
    if (values.length > 0) out["enum"] = values;
  }

  for (const key of PASSTHROUGH) {
    if (node[key] !== undefined) out[key] = node[key];
  }

  const properties = node["properties"];
  if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
    const converted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      if (typeof child === "object" && child !== null && !Array.isArray(child)) {
        converted[key] = convert(child as Record<string, unknown>);
      }
    }
    out["properties"] = converted;

    const rawRequired = node["required"];
    if (Array.isArray(rawRequired)) {
      // Drop nullable fields from `required` for the reason above.
      const required = rawRequired.filter((key) => {
        const child = converted[String(key)] as Record<string, unknown> | undefined;
        return child !== undefined && child["nullable"] !== true;
      });
      if (required.length > 0) out["required"] = required;
    }
  }

  const items = node["items"];
  if (typeof items === "object" && items !== null && !Array.isArray(items)) {
    out["items"] = convert(items as Record<string, unknown>);
  }

  return out;
}

interface GeminiPart {
  text?: unknown;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: unknown;
  }>;
  promptFeedback?: { blockReason?: unknown };
  error?: { message?: unknown; status?: unknown };
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface GeminiProvider extends AiProvider {
  readonly modelId: string;
}

export function createGeminiProvider(
  config: GeminiConfig,
  fetchImpl: FetchLike = fetch,
): GeminiProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
  const model = config.model;
  if (model.trim() === "") throw new RangeError("gemini provider needs a model id");
  const timeoutMs = config.timeoutMs ?? 8_000;

  return {
    modelId: model,
    async generate(request: AiRequest): Promise<unknown> {
      const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs || timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": config.apiKey,
          },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: "user", parts: [{ text: request.prompt }] }],
            generationConfig: {
              // D4/D12: temperature is not a tunable here.
              temperature: request.temperature,
              responseMimeType: "application/json",
              responseSchema: toGeminiSchema(request.schema),
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            },
          }),
        });
      } catch (error) {
        // Re-wrapped, never re-thrown: a fetch rejection can carry the request
        // init (and therefore the key) in its message.
        throw new AiProviderError(
          `gemini request failed: ${error instanceof Error ? error.name : "unknown error"}`,
          { retryable: true },
        );
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      if (!response.ok) {
        throw new AiProviderError(
          `gemini returned HTTP ${response.status}: ${snippet(text, config.apiKey)}`,
          { status: response.status },
        );
      }

      let payload: GeminiResponse;
      try {
        payload = JSON.parse(text) as GeminiResponse;
      } catch {
        throw new AiProviderError("gemini response was not JSON", { retryable: true });
      }

      const blockReason = payload.promptFeedback?.blockReason;
      if (typeof blockReason === "string" && blockReason !== "") {
        throw new AiProviderError(
          `gemini blocked the prompt (${snippet(String(blockReason), config.apiKey)})`,
          { retryable: false },
        );
      }

      const candidate = payload.candidates?.[0];
      const finishReason = candidate?.finishReason;
      if (typeof finishReason === "string" && FATAL_FINISH_REASONS.has(finishReason)) {
        throw new AiProviderError(
          `gemini stopped early (${snippet(String(finishReason), config.apiKey)})`,
          { retryable: false },
        );
      }

      const parts = candidate?.content?.parts ?? [];
      const output = parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();
      if (output === "") {
        throw new AiProviderError("gemini returned no text part", { retryable: false });
      }

      // TEXT, not a parsed object: `parseAiOutput` owns the contract, so a
      // vendor that stops honouring `responseSchema` fails in one place.
      return output;
    },
  };
}
