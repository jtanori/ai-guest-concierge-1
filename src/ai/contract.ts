/**
 * S05-01 / D4 — the AI output contract, and the validator that is the AC.
 *
 * The AC is one sentence: *malformed output is rejected server-side, never
 * sent.* Everything here exists to make that true against a provider that is
 * asked for JSON and may still return something else: a truncated string, a
 * correct-looking object with a citation the retrieval never produced, a
 * confidence of 1.4, an answer with no citation at all. None of those may reach
 * a guest, and "the model was told to follow the schema" is not a control.
 *
 * It is hand-written rather than schema-library-driven for the same reason
 * DEC-3's embedding adapter is: one dependency-free module, no supply chain,
 * and the failure messages name the field. `AI_OUTPUT_JSON_SCHEMA` in
 * `prompt.ts` is the provider-facing twin; the two are deliberately independent
 * (a provider that enforces its schema still has to survive this one).
 *
 * THE DECISION VOCABULARY IS NOT THE TABLE'S. Appendix B says
 * `answer | needs_human | no_answer`; `ai_runs.decision` (0001) says
 * `answer | escalate | no_answer`. Both are correct for their layer: the model
 * does not get to know whether an escalation is a handoff, a draft or a
 * refusal — that is policy (S05-02) — so the contract keeps the model's word and
 * `toRunDecision` is the single place the mapping happens.
 */
export const AI_DECISIONS = ["answer", "needs_human", "no_answer"] as const;
export type AiDecision = (typeof AI_DECISIONS)[number];

/**
 * Appendix B, verbatim — **the model's** vocabulary.
 *
 * A fixed set: a made-up code cannot be alerted on. This is also the enum sent
 * to the model in the JSON schema (`prompt.ts`), which is why it does not grow
 * to hold the pipeline's own codes: "the model said `provider_unavailable`" is
 * not a sentence anyone should be able to write.
 */
export const AI_REASON_CODES = [
  "low_retrieval",
  "sensitive_topic",
  "booking_intent",
  "guest_asked_human",
  "policy_block",
  "contradiction",
] as const;
export type AiReasonCode = (typeof AI_REASON_CODES)[number];

/**
 * S07-05 — what `ai_runs.reason_code` may hold: the model's codes **plus the
 * reasons the pipeline itself refuses**. Currently one:
 *
 *  - `provider_unavailable` — both providers failed, so no model produced this
 *    run. The row exists precisely because "the AI was down" must be
 *    distinguishable in `ai_runs` from "the AI answered badly", and neither is a
 *    reason to leave no row: an outage that leaves no trace is invisible in
 *    every accuracy number that samples `ai_runs`.
 *
 * A superset rather than a widened `AiReasonCode`, so the two vocabularies stay
 * honest about who says what. `recordAiRun` validates against this one.
 */
export const AI_RUN_REASON_CODES = [...AI_REASON_CODES, "provider_unavailable"] as const;
export type AiRunReasonCode = (typeof AI_RUN_REASON_CODES)[number];

/** `ai_runs.decision` (0001). The table's vocabulary, not the model's. */
export const AI_RUN_DECISIONS = ["answer", "escalate", "no_answer"] as const;
export type AiRunDecision = (typeof AI_RUN_DECISIONS)[number];

export const AI_OUTPUT_LIMITS = {
  /** A guest message, not an essay. Generous for a structured answer. */
  answerChars: 1200,
  quoteChars: 400,
  citations: 8,
  topicKeys: 12,
  languageChars: 16,
} as const;

export interface AiCitation {
  /** D5: the VERSION is cited, never the article. */
  articleVersionId: string;
  quote: string;
}

export interface AiOutput {
  decision: AiDecision;
  /** null for every decision except `answer`. */
  answer: string | null;
  language: string;
  citations: AiCitation[];
  /** null only for `answer`. */
  reasonCode: AiReasonCode | null;
  topicKeysUsed: string[];
  confidence: number;
}

export class AiContractError extends Error {
  /** Every violation found, not just the first: one retry, one report. */
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`AI output rejected: ${violations.join("; ")}`);
    this.name = "AiContractError";
    this.violations = violations;
  }
}

export interface ParseContext {
  /**
   * `article_version_id`s the retrieval actually returned for this turn. A
   * citation outside this set is the dangerous failure: it looks authoritative
   * and points at something the answer was not derived from.
   */
  allowedVersionIds: readonly string[];
  /** `topic_key`s of those same hits. */
  allowedTopicKeys?: readonly string[];
  /** Optional override for tests; production uses AI_OUTPUT_LIMITS. */
  limits?: Partial<typeof AI_OUTPUT_LIMITS>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string): boolean => UUID.test(value);

const TOPIC_KEY = /^[a-z0-9][a-z0-9_.-]{0,119}$/;
/** BCP-47 shape, e.g. `es`, `es-MX`. Not a registry lookup: the model names the
 *  language it answered in, and the property's languages gate it elsewhere. */
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const OUTPUT_KEYS = [
  "decision",
  "answer",
  "language",
  "citations",
  "reason_code",
  "topic_keys_used",
  "confidence",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates raw provider output against Appendix B.
 *
 * Throws `AiContractError` listing every violation. It does NOT escalate by
 * itself: escalation needs the tenant's policy (`needs_human` vs `no_answer`
 * vs draft), which is the caller's job — this module stays pure so the eval
 * harness and the pipeline judge output the same way.
 */
export function parseAiOutput(raw: unknown, context: ParseContext): AiOutput {
  const limits = { ...AI_OUTPUT_LIMITS, ...context.limits };
  const violations: string[] = [];
  const push = (message: string): void => {
    violations.push(message);
  };

  let value: unknown = raw;
  // Providers sometimes return the JSON as a string, or wrap it in an array of
  // one. Unwrapping is safe because the shape is still validated afterwards.
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new AiContractError(["output is not JSON"]);
    }
  }
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (!isRecord(value)) throw new AiContractError(["output is not a JSON object"]);

  for (const key of Object.keys(value)) {
    if (!(OUTPUT_KEYS as readonly string[]).includes(key)) push(`unknown field "${key}"`);
  }
  for (const key of OUTPUT_KEYS) {
    if (!(key in value)) push(`missing field "${key}"`);
  }

  const decision = value["decision"];
  if (typeof decision !== "string" || !(AI_DECISIONS as readonly string[]).includes(decision)) {
    push(`decision must be one of ${AI_DECISIONS.join(" | ")}, got ${JSON.stringify(decision)}`);
  }
  const isAnswer = decision === "answer";

  // ---- answer ----
  const answer = value["answer"];
  let normalizedAnswer: string | null = null;
  if (isAnswer) {
    if (typeof answer !== "string" || answer.trim() === "") {
      push("answer must be a non-empty string when decision is \"answer\"");
    } else if (answer.length > limits.answerChars) {
      push(`answer exceeds ${limits.answerChars} characters`);
    } else {
      normalizedAnswer = answer.trim();
    }
  } else if (answer !== null) {
    // A non-answer carrying prose is the exact leak this contract prevents:
    // someone would eventually send it.
    push("answer must be null unless decision is \"answer\"");
  }

  // ---- language ----
  const language = value["language"];
  if (typeof language !== "string" || !LANGUAGE.test(language)) {
    push(`language must be a BCP-47 tag like "es-MX", got ${JSON.stringify(language)}`);
  } else if (language.length > limits.languageChars) {
    push(`language exceeds ${limits.languageChars} characters`);
  }

  // ---- citations ----
  const citations: AiCitation[] = [];
  const rawCitations = value["citations"];
  if (!Array.isArray(rawCitations)) {
    push("citations must be an array");
  } else {
    if (rawCitations.length > limits.citations) {
      push(`citations exceeds ${limits.citations} entries`);
    }
    if (isAnswer && rawCitations.length === 0) {
      push("an answer requires at least one citation");
    }
    if (!isAnswer && rawCitations.length > 0) {
      push("only an answer may carry citations");
    }
    rawCitations.forEach((entry, index) => {
      if (!isRecord(entry)) {
        push(`citations[${index}] is not an object`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (key !== "article_version_id" && key !== "quote") {
          push(`citations[${index}] has unknown field "${key}"`);
        }
      }
      const versionId = entry["article_version_id"];
      if (typeof versionId !== "string" || !isUuid(versionId)) {
        push(`citations[${index}].article_version_id is not a uuid`);
      } else if (!context.allowedVersionIds.includes(versionId)) {
        push(`citations[${index}].article_version_id was not retrieved for this turn`);
      }
      const quote = entry["quote"];
      if (typeof quote !== "string" || quote.trim() === "") {
        push(`citations[${index}].quote must be a non-empty string`);
      } else if (quote.length > limits.quoteChars) {
        push(`citations[${index}].quote exceeds ${limits.quoteChars} characters`);
      } else if (typeof versionId === "string") {
        citations.push({ articleVersionId: versionId, quote: quote.trim() });
      }
    });
  }

  // ---- reason_code ----
  const reasonCode = value["reason_code"];
  let normalizedReason: AiReasonCode | null = null;
  if (isAnswer) {
    if (reasonCode !== null) push("reason_code must be null when decision is \"answer\"");
  } else if (typeof reasonCode !== "string") {
    push("reason_code is required unless decision is \"answer\"");
  } else if (!(AI_REASON_CODES as readonly string[]).includes(reasonCode)) {
    push(`reason_code must be one of ${AI_REASON_CODES.join(" | ")}, got ${JSON.stringify(reasonCode)}`);
  } else {
    normalizedReason = reasonCode as AiReasonCode;
  }

  // ---- topic_keys_used ----
  const topicKeys: string[] = [];
  const rawTopics = value["topic_keys_used"];
  if (!Array.isArray(rawTopics)) {
    push("topic_keys_used must be an array");
  } else {
    if (rawTopics.length > limits.topicKeys) push(`topic_keys_used exceeds ${limits.topicKeys}`);
    rawTopics.forEach((entry, index) => {
      if (typeof entry !== "string" || !TOPIC_KEY.test(entry)) {
        push(`topic_keys_used[${index}] is not a topic key`);
        return;
      }
      if (context.allowedTopicKeys !== undefined && !context.allowedTopicKeys.includes(entry)) {
        push(`topic_keys_used[${index}] "${entry}" was not retrieved for this turn`);
        return;
      }
      if (!topicKeys.includes(entry)) topicKeys.push(entry);
    });
  }

  // ---- confidence ----
  const confidence = value["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    push("confidence must be a number");
  } else if (confidence < 0 || confidence > 1) {
    push(`confidence must be within 0..1, got ${confidence}`);
  }

  if (violations.length > 0) throw new AiContractError(violations);

  return {
    decision: decision as AiDecision,
    answer: normalizedAnswer,
    language: language as string,
    citations,
    reasonCode: normalizedReason,
    topicKeysUsed: topicKeys,
    confidence: confidence as number,
  };
}

/** The one place the model's vocabulary becomes the table's (see the header). */
export function toRunDecision(decision: AiDecision): AiRunDecision {
  return decision === "needs_human" ? "escalate" : decision;
}

/**
 * True when the output may be sent to a guest as-is. `false` is not an error
 * path: it is the escalation path, and it is the normal outcome for every
 * `needs_human` / `no_answer` decision.
 */
export function isSendable(output: AiOutput): boolean {
  return output.decision === "answer" && output.citations.length > 0;
}
