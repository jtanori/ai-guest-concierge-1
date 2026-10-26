/**
 * S05-01 / AC-3 — every model call leaves a row.
 *
 * `ai_runs` is the only place that records WHICH model and WHICH prompt version
 * produced an answer. Without it, a change in guest-visible behaviour cannot be
 * attributed to a prompt edit, a model swap or a retrieved article — and the
 * pilot's accuracy sampling (Appendix D) has nothing to sample from.
 *
 * Two rules this module keeps:
 *
 *  - **One row per call, not per answer.** A run that ended in `escalate` still
 *    gets a row; that is how "needless escalation" is measured.
 *  - **Citations point at versions (D5).** `citations.article_version_id` is a
 *    foreign key with ON DELETE RESTRICT: an answer's citation cannot be
 *    quietly deleted out from under it.
 *
 * The caller owns BEGIN/COMMIT — this joins whatever transaction produced the
 * answer, so a rolled-back turn leaves no orphan `ai_runs` row claiming an
 * answer that was never sent.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import type { AiRunDecision, AiRunReasonCode } from "./contract.ts";
import { AI_RUN_DECISIONS, AI_RUN_REASON_CODES } from "./contract.ts";

export interface AiRunInput {
  conversationId: string;
  messageId: string | null;
  /** Pinned id of the model that actually answered (primary or fallback). */
  modelId: string;
  promptVersion: string;
  decision: AiRunDecision;
  /**
   * S07-05: the closed vocabulary — the model's codes plus `provider_unavailable`.
   * Typed rather than `string` so a typo is a compile error and an invented code
   * is a runtime refusal, which is what makes `ai_runs.reason_code` queryable.
   */
  reasonCode: AiRunReasonCode | null;
  confidence: number | null;
  latencyMs: number | null;
  usage?: Record<string, unknown>;
}

export class AiRunError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordAiRun(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: AiRunInput,
): Promise<string> {
  assertTenantShape(context);

  if (!UUID.test(input.conversationId)) throw new AiRunError("conversationId must be a uuid");
  if (input.messageId !== null && !UUID.test(input.messageId)) {
    throw new AiRunError("messageId must be a uuid or null");
  }
  if (input.modelId.trim() === "") throw new AiRunError("modelId is required");
  if (input.promptVersion.trim() === "") throw new AiRunError("promptVersion is required");
  if (!(AI_RUN_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new AiRunError(`decision must be one of ${AI_RUN_DECISIONS.join(" | ")}`);
  }
  if (input.reasonCode !== null && !(AI_RUN_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
    throw new AiRunError(`reasonCode must be one of ${AI_RUN_REASON_CODES.join(" | ")}`);
  }
  if (input.confidence !== null && (input.confidence < 0 || input.confidence > 1)) {
    throw new AiRunError("confidence must be within 0..1");
  }
  if (input.latencyMs !== null && (!Number.isInteger(input.latencyMs) || input.latencyMs < 0)) {
    throw new AiRunError("latencyMs must be a non-negative integer");
  }

  const result = await client.query<{ ai_run_id: string }>(
    `INSERT INTO ai_runs
       (org_id, property_id, conversation_id, message_id, model_id, prompt_version,
        decision, reason_code, confidence, latency_ms, usage)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     RETURNING ai_run_id`,
    [
      context.orgId,
      context.propertyId,
      input.conversationId,
      input.messageId,
      input.modelId,
      input.promptVersion,
      input.decision,
      input.reasonCode,
      input.confidence,
      input.latencyMs,
      JSON.stringify(input.usage ?? {}),
    ],
  );
  return result.rows[0]!.ai_run_id;
}

/**
 * Writes the citation rows for one run.
 *
 * Duplicates are collapsed: a model that cites the same article twice has made
 * one claim, and two rows would double-count it in every "sources used" number.
 * The foreign key is what makes an unretrieved or deleted version impossible.
 */
export async function recordCitations(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  aiRunId: string,
  articleVersionIds: readonly string[],
): Promise<number> {
  assertTenantShape(context);
  if (!UUID.test(aiRunId)) throw new AiRunError("aiRunId must be a uuid");

  const seen = new Set<string>();
  for (const articleVersionId of articleVersionIds) {
    if (!UUID.test(articleVersionId)) {
      throw new AiRunError(`articleVersionId ${articleVersionId} is not a uuid (D5: versions, never articles)`);
    }
    if (seen.has(articleVersionId)) continue;
    seen.add(articleVersionId);
    await client.query(
      `INSERT INTO citations (org_id, property_id, ai_run_id, article_version_id)
       VALUES ($1, $2, $3, $4)`,
      [context.orgId, context.propertyId, aiRunId, articleVersionId],
    );
  }
  return seen.size;
}
