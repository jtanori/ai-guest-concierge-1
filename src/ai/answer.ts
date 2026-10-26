/**
 * S05-01 — the answer pipeline.
 *
 * The order below is the contract, and every step exists to stop a specific
 * wrong answer reaching a guest:
 *
 *   policy  → is this property allowed to answer at all, on this topic, now?
 *   facts   → a verified number beats anything a model can read out of prose.
 *   retrieve→ if nothing was retrieved, there is nothing to answer from.
 *   generate→ temperature 0, no tools, provider-native JSON.
 *   validate→ `parseAiOutput`: the AC. Malformed output is never sent.
 *   persist → one `ai_runs` row per call, citations pointing at versions.
 *   emit    → the event the dashboards read.
 *
 * What is deliberately NOT here: the guardrail pass (S05-02), the conversation
 * state machine (S06-02), and the vendor adapter (DEC-2 closed on Gemini,
 * `src/providers/gemini.ts`). Each attaches at a named step, not by editing the
 * middle of this one.
 *
 * Two honest gaps, marked where they occur:
 *  - **Topic classification** does not exist yet. The caller may pass
 *    `topicKey` (from the golden-set harness or a future classifier); when it
 *    is absent, topic-scoped policy cannot be evaluated and is skipped, which is
 *    stated in the returned outcome rather than silently assumed to pass.
 *  - **The retrieve-gate is "nothing retrieved", not a score threshold.** RRF
 *    scores are rank-derived (`Σ w/(60+rank)`), so any absolute cutoff invented
 *    today would be a number with no evidence behind it. Calibration belongs to
 *    S06-03, where the golden set can measure it.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import { emitEvent } from "../events/emit.ts";
import type { Channel } from "../events/taxonomy.ts";
import type { Lang } from "../i18n/catalog.ts";
import { resolveAnswerSource, type StructuredQuestion } from "../knowledge/answer.ts";
import { lookupFact, type FactLookupResult } from "../knowledge/facts.ts";
import type { RetrievalHit } from "../knowledge/retrieval.ts";
import { isAfterHours, isTopicEnabled, type AiMode } from "../settings/policy.ts";
import { parsePropertySettings, type PropertySettings } from "../settings/schema.ts";
import {
  AiContractError,
  parseAiOutput,
  toRunDecision,
  type AiOutput,
  type AiReasonCode,
} from "./contract.ts";
import {
  AI_OUTPUT_JSON_SCHEMA,
  PROMPT_VERSION,
  buildPrompt,
  promptArticlesFromHits,
} from "./prompt.ts";
import { AiUnavailableError, GENERATION_TIMEOUT_MS, type ResilientAi } from "./provider.ts";
import { recordAiRun, recordCitations } from "./runs.ts";

export interface AnswerMessageInput {
  conversationId: string;
  messageId: string | null;
  text: string;
  language: Lang | null;
  channel: Channel;
  /** Guest's clock. Injected so after-hours policy is testable. */
  at?: Date;
  /** Structured half of the question, when the caller could name it. */
  structured?: StructuredQuestion;
  /** Classifier output; absent means "not classified yet". */
  topicKey?: string | null;
  /** Question embedding for the vector branch; omitted means lexical+trigram. */
  embedding?: number[];
}

export interface AnswerDeps {
  ai: ResilientAi;
  /** Overrides `PROMPT_VERSION` only for eval runs that pin a prompt. */
  promptVersion?: string;
}

export type AnswerOutcome =
  | {
      kind: "answer";
      output: AiOutput;
      aiRunId: string;
      modelId: string;
      usedFallback: boolean;
      hits: RetrievalHit[];
    }
  | { kind: "fact"; fact: FactLookupResult; topicKey: string; factKey: string }
  | { kind: "no_answer"; reasonCode: "low_retrieval"; eventId: bigint }
  | {
      kind: "escalate";
      reasonCode: AiReasonCode;
      /** Machine-readable cause, e.g. "mode_human_only" or "contract_violation". */
      detail: string;
      aiRunId: string | null;
    }
  /** Both providers failed: the outage path (S07-05), never a 500. */
  | { kind: "unavailable"; detail: string };

interface PropertyRow {
  ai_mode: AiMode;
  time_zone: string;
  languages: string[];
  settings: unknown;
}

/**
 * The policy causes are evaluated individually rather than through
 * `escalationDecision`, for one reason: the pipeline must REPORT which rule
 * blocked (the operator needs to know "after hours" is not "topic disabled"),
 * and classification may not have produced a topic key yet, so the topic rule
 * cannot always be evaluated at all.
 */
function policyBlock(
  settings: PropertySettings,
  input: { aiMode: AiMode; timeZone: string; at: Date; topicKey: string | null },
): { reasonCode: AiReasonCode; detail: string } | null {
  if (input.aiMode === "human_only") return { reasonCode: "policy_block", detail: "mode_human_only" };
  if (input.aiMode === "draft") return { reasonCode: "policy_block", detail: "mode_draft" };
  if (input.aiMode === "after_hours" && isAfterHours(settings, input.at, input.timeZone)) {
    return { reasonCode: "policy_block", detail: "after_hours" };
  }
  if (input.topicKey !== null && !isTopicEnabled(settings, input.topicKey)) {
    return { reasonCode: "policy_block", detail: "topic_disabled" };
  }
  return null;
}

export async function answerMessage(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: AnswerMessageInput,
  deps: AnswerDeps,
): Promise<AnswerOutcome> {
  assertTenantShape(context);
  const at = input.at ?? new Date();
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text === "") throw new RangeError("answerMessage needs a non-empty question");

  const property = await client.query<PropertyRow>(
    "SELECT ai_mode, time_zone, languages, settings FROM properties WHERE org_id = $1 AND property_id = $2",
    [context.orgId, context.propertyId],
  );
  const row = property.rows[0];
  if (row === undefined) {
    throw new RangeError(`property ${context.propertyId} is not visible in this context`);
  }
  const settings = parsePropertySettings(row.settings);

  const eventBase = {
    orgId: context.orgId,
    propertyId: context.propertyId,
    conversationId: input.conversationId,
    channel: input.channel,
    language: input.language,
    topic: input.topicKey ?? null,
    createdAt: at.toISOString(),
  };

  // ---- 1. policy -------------------------------------------------------
  const blocked = policyBlock(settings, {
    aiMode: row.ai_mode,
    timeZone: row.time_zone,
    at,
    topicKey: input.topicKey ?? null,
  });
  if (blocked !== null) {
    await emitEvent(client, context, "ai_escalated", eventBase, {
      reason_code: blocked.reasonCode,
      detail: blocked.detail,
    });
    return { kind: "escalate", reasonCode: blocked.reasonCode, detail: blocked.detail, aiRunId: null };
  }

  // ---- 2. verified facts (S03-03) beat prose ---------------------------
  if (input.structured !== undefined) {
    const fact = await lookupFact(client, context, input.structured);
    if (fact !== null) {
      // No `ai_runs` row on purpose: no model was called, and a row here would
      // make "answers per model" numbers meaningless. The event still records
      // that an answer was sent, and from where.
      await emitEvent(client, context, "ai_answer_sent", eventBase, {
        source: "fact",
        topic_key: input.structured.topicKey,
        fact_key: input.structured.factKey,
      });
      return {
        kind: "fact",
        fact,
        topicKey: input.structured.topicKey,
        factKey: input.structured.factKey,
      };
    }
  }

  // ---- 3. retrieval ----------------------------------------------------
  const source = await resolveAnswerSource(client, context, {
    text,
    ...(input.embedding === undefined ? {} : { embedding: input.embedding }),
  });
  const hits = source.kind === "articles" ? source.hits : [];
  if (hits.length === 0) {
    // Weak retrieval is a legitimate "I don't know", not an exception to log
    // and ignore. S09-02 turns this event into a knowledge-gap row.
    const eventId = await emitEvent(client, context, "no_answer_emitted", eventBase, {
      reason_code: "low_retrieval",
    });
    return { kind: "no_answer", reasonCode: "low_retrieval", eventId };
  }

  // ---- 4. generate -----------------------------------------------------
  const prompt = buildPrompt({
    question: text,
    propertyLanguage: row.languages[0] ?? "es",
    tone: settings.tone,
    articles: promptArticlesFromHits(hits),
  });

  let generated: Awaited<ReturnType<ResilientAi["generate"]>>;
  try {
    generated = await deps.ai.generate({
      system: prompt.system,
      prompt: prompt.prompt,
      schema: AI_OUTPUT_JSON_SCHEMA,
      temperature: 0,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      // The caller sends "our team will reply" and creates a request (S07-05).
      return { kind: "unavailable", detail: error.message };
    }
    throw error;
  }

  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;
  const baseRun = {
    conversationId: input.conversationId,
    messageId: input.messageId,
    modelId: generated.modelId,
    promptVersion,
    latencyMs: generated.latencyMs,
    usage: { attempts: generated.attempts, used_fallback: generated.usedFallback },
  };

  // ---- 5. validate (the AC) -------------------------------------------
  let output: AiOutput;
  try {
    output = parseAiOutput(generated.raw, {
      allowedVersionIds: hits.map((hit) => hit.articleVersionId),
      allowedTopicKeys: hits.map((hit) => hit.topicKey),
    });
  } catch (error) {
    if (!(error instanceof AiContractError)) throw error;
    // Never sent. The call still happened, so it still gets a row — that row is
    // how the parse-failure rate (S07-06's alert) is computed.
    const aiRunId = await recordAiRun(client, context, {
      ...baseRun,
      decision: "escalate",
      reasonCode: "policy_block",
      confidence: null,
      usage: {
        ...baseRun.usage,
        // A count for the alert, a capped sample for the person debugging it.
        contract_violations: error.violations.length,
        violations: error.violations.slice(0, 5),
      },
    });
    await emitEvent(client, context, "ai_escalated", eventBase, {
      reason_code: "policy_block",
      detail: "contract_violation",
      ai_run_id: aiRunId,
      violations: error.violations.length,
    });
    return {
      kind: "escalate",
      reasonCode: "policy_block",
      detail: "contract_violation",
      aiRunId,
    };
  }

  // ---- 6. persist + emit ----------------------------------------------
  const aiRunId = await recordAiRun(client, context, {
    ...baseRun,
    decision: toRunDecision(output.decision),
    reasonCode: output.reasonCode,
    confidence: output.confidence,
  });
  await emitEvent(client, context, "ai_run_completed", eventBase, {
    ai_run_id: aiRunId,
    model_id: generated.modelId,
    prompt_version: promptVersion,
    decision: output.decision,
    confidence: output.confidence,
    latency_ms: generated.latencyMs,
    used_fallback: generated.usedFallback,
  });

  if (output.decision === "answer") {
    const cited = await recordCitations(
      client,
      context,
      aiRunId,
      output.citations.map((citation) => citation.articleVersionId),
    );
    await emitEvent(client, context, "ai_answer_sent", eventBase, {
      ai_run_id: aiRunId,
      citations: cited,
      source: "retrieval",
    });
    return {
      kind: "answer",
      output,
      aiRunId,
      modelId: generated.modelId,
      usedFallback: generated.usedFallback,
      hits,
    };
  }

  if (output.decision === "needs_human") {
    await emitEvent(client, context, "ai_escalated", eventBase, {
      ai_run_id: aiRunId,
      reason_code: output.reasonCode,
    });
    return {
      kind: "escalate",
      reasonCode: output.reasonCode ?? "policy_block",
      detail: "model_needs_human",
      aiRunId,
    };
  }

  await emitEvent(client, context, "no_answer_emitted", eventBase, {
    ai_run_id: aiRunId,
    reason_code: output.reasonCode ?? "low_retrieval",
  });
  return { kind: "no_answer", reasonCode: "low_retrieval", eventId: 0n };
}
