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
import { CREATED_AT_ISO_SQL, type CreatedAtIsoRow } from "../events/clock.ts";

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

/**
 * The run's id plus the exact stamp of the row that holds it.
 *
 * `createdAtIso` exists because of issue #147: the `ai_runs` reconciliation metric
 * counts `DISTINCT payload->>'ai_run_id'` over `events` against `count(*)` over
 * `ai_runs`, windowed on each side's own `created_at`. Every event carrying this run's
 * id must therefore be stamped with THIS row's created_at, or a window boundary can
 * admit the run and exclude its events (or the reverse) and report a delta that reads
 * as missing instrumentation. Callers pass it straight into `EventContext.createdAt`.
 */
export interface RecordedAiRun {
  aiRunId: string;
  createdAtIso: string;
}

export async function recordAiRun(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: AiRunInput,
): Promise<RecordedAiRun> {
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

  const result = await client.query<{ ai_run_id: string } & CreatedAtIsoRow>(
    `INSERT INTO ai_runs
       (org_id, property_id, conversation_id, message_id, model_id, prompt_version,
        decision, reason_code, confidence, latency_ms, usage)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     RETURNING ai_run_id, ${CREATED_AT_ISO_SQL}`,
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
  const row = result.rows[0]!;
  return { aiRunId: row.ai_run_id, createdAtIso: row.created_at_iso };
}

/**
 * Writes the citation rows for one run.
 *
 * Duplicates are collapsed: a model that cites the same article twice has made
 * one claim, and two rows would double-count it in every "sources used" number.
 * The foreign key is what makes an unretrieved or deleted version impossible.
 */
export interface CitedVersion {
  articleVersionId: string;
  /**
   * S08-02 — the model's supporting quote, already proven to appear in the
   * version by `src/ai/guard.ts`. Optional so a caller that only knows the id
   * (a backfill, a reconstruction) can still record the citation.
   */
  quote?: string | null;
}

export async function recordCitations(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  aiRunId: string,
  citations: readonly (CitedVersion | string)[],
): Promise<number> {
  assertTenantShape(context);
  if (!UUID.test(aiRunId)) throw new AiRunError("aiRunId must be a uuid");

  // Collapsed by version, and the FIRST non-empty quote wins: the same version
  // cited twice is one claim, and the earliest quote is the one the guard
  // checked against the same text.
  const quotes = new Map<string, string | null>();
  for (const entry of citations) {
    const articleVersionId = typeof entry === "string" ? entry : entry.articleVersionId;
    const quote = typeof entry === "string" ? null : (entry.quote ?? null);
    if (!UUID.test(articleVersionId)) {
      throw new AiRunError(`articleVersionId ${articleVersionId} is not a uuid (D5: versions, never articles)`);
    }
    const existing = quotes.get(articleVersionId);
    if (existing === undefined) {
      quotes.set(articleVersionId, quote);
    } else if (existing === null && quote !== null) {
      quotes.set(articleVersionId, quote);
    }
  }

  for (const [articleVersionId, quote] of quotes) {
    await client.query(
      `INSERT INTO citations (org_id, property_id, ai_run_id, article_version_id, quote)
       VALUES ($1, $2, $3, $4, $5)`,
      [context.orgId, context.propertyId, aiRunId, articleVersionId, quote],
    );
  }
  return quotes.size;
}
