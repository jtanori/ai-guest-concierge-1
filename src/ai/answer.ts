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
import type { Channel, EventContext } from "../events/taxonomy.ts";
import { t, type Lang } from "../i18n/catalog.ts";
import { resolveAnswerSource, type StructuredQuestion } from "../knowledge/answer.ts";
import {
  listContradictions,
  lookupFact,
  type FactLookupResult,
} from "../knowledge/facts.ts";
import type { RetrievalHit } from "../knowledge/retrieval.ts";
import type { AiMode } from "../settings/policy.ts";
import { policyGate } from "./policy.ts";
import { verifyAnswer } from "./guard.ts";
import { classifySensitive } from "./sensitive.ts";
import { parsePropertySettings } from "../settings/schema.ts";
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
  /** Spend so far today, from S07-04's counter. Omitted when unknown. */
  spendTodayUsd?: number;
  /** Spend so far in this conversation, from S07-04's counter. */
  conversationSpendUsd?: number;
  /** Guardrail confidence floor; 0 (default) leaves it off until calibrated. */
  minConfidence?: number;
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
  | {
      kind: "no_answer";
      reasonCode: "low_retrieval";
      eventId: bigint;
      /** The catalogue string the channel sends — never model text. */
      guestMessage: string;
    }
  | {
      kind: "escalate";
      reasonCode: AiReasonCode;
      /** Machine-readable cause, e.g. "mode_human_only" or "contract_violation". */
      detail: string;
      aiRunId: string | null;
      guestMessage: string;
    }
  /** Both providers failed: the outage path (S07-05), never a 500. */
  | { kind: "unavailable"; detail: string };

interface PropertyRow {
  ai_mode: AiMode;
  time_zone: string;
  languages: string[];
  settings: unknown;
}

/** The catalogue string for every non-answer path (D14: no hardcoded copy). */
function idontknow(language: Lang | null): string {
  return t("guest.idontknow", language ?? "es");
}

/**
 * A gap row is what makes a refusal actionable. Both no-answer paths write one
 * — the empty-retrieval path and the model's own `no_answer` — so they share
 * this, because a second copy of the column list is how the two drift apart.
 */
async function recordKnowledgeGap(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: { conversationId: string; text: string; language: Lang | null },
  why: { reason_code: string },
  eventBase: EventContext,
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_gaps (org_id, property_id, conversation_id, question, language)
     VALUES ($1, $2, $3, $4, $5)`,
    [context.orgId, context.propertyId, input.conversationId, input.text, input.language],
  );
  await emitEvent(client, context, "knowledge_gap_created", eventBase, why);
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
  const gate = policyGate({
    settings,
    aiMode: row.ai_mode,
    topicKey: input.topicKey ?? null,
    at,
    timeZone: row.time_zone,
    ...(deps.spendTodayUsd === undefined ? {} : { spendTodayUsd: deps.spendTodayUsd }),
    ...(deps.conversationSpendUsd === undefined
      ? {}
      : { conversationSpendUsd: deps.conversationSpendUsd }),
  });
  if (!gate.allow) {
    await emitEvent(client, context, "ai_escalated", eventBase, {
      reason_code: gate.reasonCode,
      detail: gate.detail,
    });
    return {
      kind: "escalate",
      reasonCode: gate.reasonCode ?? "policy_block",
      detail: gate.detail,
      aiRunId: null,
      guestMessage: idontknow(input.language),
    };
  }

  // ---- 1b. sensitive topics and intents (S05-02 AC-2) ------------------
  // Before retrieval, before facts and before any model call: the point of a
  // guardrail is that it costs nothing and cannot be argued with.
  const sensitive = classifySensitive(text, input.language);
  if (sensitive !== null) {
    await emitEvent(client, context, "ai_escalated", eventBase, {
      reason_code: sensitive.reasonCode,
      detail: `sensitive:${sensitive.ruleId}`,
    });
    return {
      kind: "escalate",
      reasonCode: sensitive.reasonCode,
      detail: `sensitive:${sensitive.ruleId}`,
      aiRunId: null,
      guestMessage: idontknow(input.language),
    };
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

  // ---- 3b. unresolved contradictions (S05-02 / S03-03) -----------------
  // If the sources disagree with a VERIFIED value, answering means picking a
  // side arbitrarily. G1 requires zero unresolved contradictions before a
  // property goes live; until then the honest move is a human.
  const contradictions = await listContradictions(client, context);
  const topicsInPlay = new Set(hits.map((hit) => hit.topicKey));
  if (input.structured !== undefined) topicsInPlay.add(input.structured.topicKey);
  const contested = contradictions.find(
    (entry) =>
      topicsInPlay.has(entry.topicKey) &&
      new Set(entry.entries.map((item) => item.value)).size > 1 &&
      entry.entries.some((item) => item.verified),
  );
  if (contested !== undefined) {
    await emitEvent(client, context, "ai_escalated", eventBase, {
      reason_code: "contradiction",
      detail: `contradiction:${contested.topicKey}.${contested.factKey}`,
    });
    return {
      kind: "escalate",
      reasonCode: "contradiction",
      detail: `contradiction:${contested.topicKey}.${contested.factKey}`,
      aiRunId: null,
      guestMessage: idontknow(input.language),
    };
  }
  if (hits.length === 0) {
    // Weak retrieval is a legitimate "I don't know", not an exception to log
    // and ignore. The gap row is what makes it actionable: the verbatim
    // question, in the guest's language, in the queue the hotel already reads.
    const eventId = await emitEvent(client, context, "no_answer_emitted", eventBase, {
      reason_code: "low_retrieval",
    });
    await recordKnowledgeGap(
      client,
      context,
      { conversationId: input.conversationId, text, language: input.language },
      { reason_code: "low_retrieval" },
      eventBase,
    );
    return {
      kind: "no_answer",
      reasonCode: "low_retrieval",
      eventId,
      guestMessage: idontknow(input.language),
    };
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
      guestMessage: idontknow(input.language),
    };
  }

  // ---- 5b. the guardrail gate (S05-02 AC-1) ---------------------------
  const guarded = verifyAnswer(output, hits, {
    ...(deps.minConfidence === undefined ? {} : { minConfidence: deps.minConfidence }),
  });
  if (!guarded.ok) {
    const aiRunId = await recordAiRun(client, context, {
      ...baseRun,
      decision: "escalate",
      reasonCode: guarded.reasonCode,
      confidence: output.confidence,
      usage: { ...baseRun.usage, guard: guarded.detail, violations: guarded.violations.slice(0, 5) },
    });
    await emitEvent(client, context, "ai_escalated", eventBase, {
      reason_code: guarded.reasonCode,
      detail: guarded.detail,
      ai_run_id: aiRunId,
      violations: guarded.violations.length,
    });
    return {
      kind: "escalate",
      reasonCode: guarded.reasonCode,
      detail: guarded.detail,
      aiRunId,
      guestMessage: idontknow(input.language),
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
      guestMessage: idontknow(input.language),
    };
  }

  await emitEvent(client, context, "no_answer_emitted", eventBase, {
    ai_run_id: aiRunId,
    reason_code: output.reasonCode ?? "low_retrieval",
  });
  // The model itself said no_answer: same product state as an empty retrieval,
  // so it gets the same gap row and the same guest string.
  await recordKnowledgeGap(
    client,
    context,
    { conversationId: input.conversationId, text, language: input.language },
    { reason_code: output.reasonCode ?? "low_retrieval" },
    eventBase,
  );
  return {
    kind: "no_answer",
    reasonCode: "low_retrieval",
    eventId: 0n,
    guestMessage: idontknow(input.language),
  };
}
