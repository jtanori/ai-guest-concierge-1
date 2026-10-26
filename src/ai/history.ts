/**
 * S05-03 — any historical answer, reconstructable from the database.
 *
 * The AC is about a year from now, not today: a hotel asks "why did the bot say
 * the pool closes at 20:00 last March?", and the answer must be the actual
 * prompt version, model, decision and the article VERSIONS it cited — with the
 * bodies as they read then, even though the article has been edited twice since.
 *
 * That works only because 0003 makes versions immutable and D5 makes citations
 * point at versions. Nothing here reconstructs from `knowledge_articles`
 * (mutable, and the wrong unit); the join is `ai_runs → citations →
 * article_versions`, exactly as the schema was designed.
 *
 * WHAT IS NOT STORED, AND WHY THAT IS FINE: the verbatim `quote` from the model
 * output is not persisted (0001's `citations` has no quote column, and S05-03's
 * scope says not to change it). AC-1 asks for "citations and cited
 * article_version bodies", both of which are here. If the quote is ever needed
 * for dispute resolution it belongs in a new column, not in a JSON blob — and
 * that is a migration, not a silent change here.
 *
 * A foreign or unknown `ai_run_id` returns `AiRunNotFoundError`, never a
 * partial object: RLS already hides other tenants' rows, and this maps "0 rows"
 * to one honest error rather than an empty citation list that reads like "the
 * model cited nothing".
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import type { AiRunDecision } from "./contract.ts";

export class AiRunNotFoundError extends Error {
  constructor(aiRunId: string) {
    super(`ai_run ${aiRunId} was not found in this tenant`);
    this.name = "AiRunNotFoundError";
  }
}

export interface ReconstructedCitation {
  articleVersionId: string;
  /** The body AS CITED. Immutable since 0003; editing the article adds a version. */
  body: string;
  versionNo: number;
  topicKey: string;
  title: string;
  /** False when a newer version has since been published: the answer cited history. */
  isCurrent: boolean;
  promotedAt: string | null;
}

export interface ReconstructedHandoff {
  reasonCode: string;
  detail: string | null;
  createdAt: string;
}

export interface ReconstructedAnswer {
  aiRunId: string;
  conversationId: string;
  messageId: string | null;
  modelId: string;
  promptVersion: string;
  decision: AiRunDecision;
  reasonCode: string | null;
  confidence: number | null;
  latencyMs: number | null;
  usage: Record<string, unknown>;
  createdAt: string;
  citations: ReconstructedCitation[];
  /** Escalation reasons recorded for the same conversation, oldest first. */
  handoffs: ReconstructedHandoff[];
}

interface RunRow {
  ai_run_id: string;
  conversation_id: string;
  message_id: string | null;
  model_id: string;
  prompt_version: string;
  decision: AiRunDecision;
  reason_code: string | null;
  confidence: string | null;
  latency_ms: number | null;
  usage: Record<string, unknown>;
  created_at: Date;
}

interface CitationRow {
  article_version_id: string;
  body: string;
  version_no: number;
  topic_key: string;
  title: string;
  is_current: boolean;
  promoted_at: Date | null;
}

interface HandoffRow {
  reason_code: string;
  detail: string | null;
  created_at: Date;
}

export async function reconstructAnswer(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  aiRunId: string,
): Promise<ReconstructedAnswer> {
  assertTenantShape(context);

  const run = await client.query<RunRow>(
    `SELECT ai_run_id, conversation_id, message_id, model_id, prompt_version,
            decision, reason_code, confidence, latency_ms, usage, created_at
       FROM ai_runs
      WHERE org_id = $1 AND property_id = $2 AND ai_run_id = $3`,
    [context.orgId, context.propertyId, aiRunId],
  );
  const row = run.rows[0];
  if (row === undefined) throw new AiRunNotFoundError(aiRunId);

  // The body is read from the VERSION, never the article: this is the whole
  // point of D5, and the join key is the composite FK 0001 already enforces.
  const citations = await client.query<CitationRow>(
    `SELECT c.article_version_id,
            av.body,
            av.version_no,
            ka.topic_key,
            ka.title,
            av.is_current,
            av.promoted_at
       FROM citations c
       JOIN article_versions av
         ON av.org_id = c.org_id
        AND av.property_id = c.property_id
        AND av.article_version_id = c.article_version_id
       JOIN knowledge_articles ka
         ON ka.org_id = av.org_id
        AND ka.property_id = av.property_id
        AND ka.article_id = av.article_id
      WHERE c.org_id = $1 AND c.property_id = $2 AND c.ai_run_id = $3
      ORDER BY c.citation_id`,
    [context.orgId, context.propertyId, aiRunId],
  );

  const handoffs = await client.query<HandoffRow>(
    `SELECT reason_code, detail, created_at
       FROM handoff_reasons
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
      ORDER BY created_at`,
    [context.orgId, context.propertyId, row.conversation_id],
  );

  return {
    aiRunId: row.ai_run_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    decision: row.decision,
    reasonCode: row.reason_code,
    confidence: row.confidence === null ? null : Number(row.confidence),
    latencyMs: row.latency_ms,
    usage: row.usage,
    createdAt: row.created_at.toISOString(),
    citations: citations.rows.map((citation) => ({
      articleVersionId: citation.article_version_id,
      body: citation.body,
      versionNo: citation.version_no,
      topicKey: citation.topic_key,
      title: citation.title,
      isCurrent: citation.is_current,
      promotedAt: citation.promoted_at === null ? null : citation.promoted_at.toISOString(),
    })),
    handoffs: handoffs.rows.map((handoff) => ({
      reasonCode: handoff.reason_code,
      detail: handoff.detail,
      createdAt: handoff.created_at.toISOString(),
    })),
  };
}
