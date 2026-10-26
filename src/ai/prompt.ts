/**
 * S05-01 — the prompt, versioned and pure.
 *
 * `buildPrompt` returns a value, not a side effect, so the eval harness (S06-03)
 * can pin the exact string a version produced and diff two prompt versions
 * without a database or a provider. `PROMPT_VERSION` is stored on every
 * `ai_runs` row: without it, a regression after a prompt edit is
 * indistinguishable from a model change or a bad article.
 *
 * Two rules are encoded here rather than in prose the model may ignore:
 *
 *  1. **The retrieved articles are the only permitted source.** Each one is
 *     labelled with its `article_version_id`, which is what a citation must
 *     name (D5). The model never sees an `article_id`; it cannot cite one.
 *  2. **"I don't know" is a first-class answer.** `no_answer` is offered before
 *     the model is tempted to improvise, because the false-answer rate is the
 *     hard gate (G2, ≤2%) and a confident guess is the only way to fail it.
 *
 * The prompt never carries a tenant id, a guest id or a conversation id: none
 * of them are needed to answer, and all of them would end up in a provider log.
 */
import type { AiReasonCode } from "./contract.ts";
import { AI_DECISIONS, AI_REASON_CODES } from "./contract.ts";
import type { RetrievalHit } from "../knowledge/retrieval.ts";

export const PROMPT_VERSION = "answer-v1";

/** Bodies are truncated per article: a long noticeboard would crowd out the
 *  rest, and the matched chunk is the part that answers the question. */
const MAX_BODY_CHARS = 1500;
const MAX_ARTICLES = 8;

export interface PromptArticle {
  articleVersionId: string;
  topicKey: string;
  title: string;
  /** The chunk that matched, when retrieval knows it; else the whole body. */
  text: string;
}

export interface BuildPromptInput {
  question: string;
  /** The property's default language, e.g. `es-MX`. The model mirrors the guest. */
  propertyLanguage: string;
  tone: string;
  articles: readonly PromptArticle[];
  /** A verified fact, when the short-circuit found one (S03-03/S04-03). */
  fact?: { topicKey: string; value: string; unit: string } | undefined;
}

export interface BuiltPrompt {
  system: string;
  prompt: string;
}

/** Projection from retrieval hits to prompt articles — one definition, so the
 *  eval harness and the pipeline cannot disagree about what the model saw. */
export function promptArticlesFromHits(hits: readonly RetrievalHit[]): PromptArticle[] {
  return hits.slice(0, MAX_ARTICLES).map((hit) => ({
    articleVersionId: hit.articleVersionId,
    topicKey: hit.topicKey,
    title: hit.title,
    text: truncate(hit.matchedChunk?.body ?? hit.body, MAX_BODY_CHARS),
  }));
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const question = input.question.trim();
  if (question === "") throw new RangeError("buildPrompt needs a non-empty question");

  const system = [
    "You answer guest questions for one hotel, using ONLY the numbered articles below.",
    `Reply in the guest's language; the property's default language is ${input.propertyLanguage}.`,
    `Tone: ${input.tone}. Keep the answer short — one to three sentences.`,
    "",
    "Rules, in order of importance:",
    "1. If the articles do not contain the answer, return decision \"no_answer\" with reason_code \"low_retrieval\". Never guess.",
    "2. If the question is about money, refunds, safety, medical needs, a specific booking, or asks for a person, return \"needs_human\" with the matching reason_code.",
    "3. Every \"answer\" must cite at least one article by its article_version_id, with a short verbatim quote from that article.",
    "4. Never cite an article that is not listed. Never invent an article_version_id.",
    "5. Answer in the guest's language and set `language` to that tag.",
    "",
    "Return one JSON object and nothing else. No prose, no markdown fences.",
  ].join("\n");

  const parts: string[] = [];
  if (input.articles.length === 0) {
    parts.push("ARTICLES: (none were retrieved for this question)");
  } else {
    parts.push("ARTICLES:");
    input.articles.forEach((article, index) => {
      parts.push(
        [
          `[${index + 1}] article_version_id=${article.articleVersionId}`,
          `topic_key=${article.topicKey}`,
          `title=${article.title}`,
          article.text,
        ].join("\n"),
      );
    });
  }

  if (input.fact !== undefined) {
    parts.push(
      "",
      `VERIFIED FACT (${input.fact.topicKey}): ${input.fact.value} ${input.fact.unit}`.trimEnd(),
      "A verified fact outranks any article text above; if they disagree, use the fact.",
    );
  }

  parts.push("", "JSON SHAPE:", JSON.stringify(AI_OUTPUT_EXAMPLE, null, 2));
  parts.push("", "GUEST QUESTION:", question);

  return { system, prompt: parts.join("\n") };
}

/** Shape example, not a template: the two nullable fields are the ones models
 *  get wrong, so both forms are shown. */
const AI_OUTPUT_EXAMPLE = {
  decision: "answer",
  answer: "La alberca cierra a las 20:00.",
  language: "es-MX",
  citations: [{ article_version_id: "00000000-0000-4000-8000-000000000000", quote: "cierra a las 20:00" }],
  reason_code: null,
  topic_keys_used: ["pool.hours"],
  confidence: 0.86,
} as const satisfies {
  decision: string;
  answer: string;
  language: string;
  citations: Array<{ article_version_id: string; quote: string }>;
  reason_code: AiReasonCode | null;
  topic_keys_used: string[];
  confidence: number;
};

/**
 * The provider-facing JSON schema (structured outputs). Deliberately separate
 * from `parseAiOutput`: this constrains generation, the validator is the
 * control. A provider that ignores or degrades the schema still cannot get a
 * malformed object past `parseAiOutput`.
 */
export const AI_OUTPUT_JSON_SCHEMA = {
  name: "guest_answer",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "decision",
      "answer",
      "language",
      "citations",
      "reason_code",
      "topic_keys_used",
      "confidence",
    ],
    properties: {
      decision: { type: "string", enum: [...AI_DECISIONS] },
      answer: { type: ["string", "null"] },
      language: { type: "string" },
      citations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["article_version_id", "quote"],
          properties: {
            article_version_id: { type: "string" },
            quote: { type: "string" },
          },
        },
      },
      reason_code: { type: ["string", "null"], enum: [...AI_REASON_CODES, null] },
      topic_keys_used: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
} as const;
