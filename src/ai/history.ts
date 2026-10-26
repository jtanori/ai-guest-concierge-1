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
 * THE QUOTE IS NOW STORED (S08-02, migration 0022). S05-03 shipped without it
 * and said so here: "the verbatim quote ... belongs in a new column, not in a
 * JSON blob — and that is a migration, not a silent change". 0022 adds exactly
 * that column, so a citation now carries the sentence the model leaned on as
 * well as the body it came from. Rows written before 0022 have `quote = NULL`
 * and read back as they always did: the body, without an anchor.
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
  /**
   * The model's verbatim supporting quote (S08-02), already proven by
   * `src/ai/guard.ts` to appear in `body`. `null` for citations written before
   * 0022 — the detail view then shows the body alone, which is all S05-03 had.
   */
  quote: string | null;
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
  ai_run_id: string;
  article_version_id: string;
  quote: string | null;
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

/**
 * The citation join, once.
 *
 * Exported because S08-02 needs it for every AI message in a conversation, and a
 * second copy of this SELECT is a second place for the D5 rule to rot. The caller
 * that has one run passes one id; the detail view passes a page of them.
 *
 * Filtered by `ai_run_id = ANY(...)` rather than by `conversation_id` so the
 * tenant predicate stays the leading column of the index 0014 built.
 */
export async function loadCitations(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  aiRunIds: readonly string[],
): Promise<Map<string, ReconstructedCitation[]>> {
  assertTenantShape(context);
  const byRun = new Map<string, ReconstructedCitation[]>();
  if (aiRunIds.length === 0) return byRun;

  // The body is read from the VERSION, never the article: this is the whole
  // point of D5, and the join key is the composite FK 0001 already enforces.
  const citations = await client.query<CitationRow>(
    `SELECT c.ai_run_id,
            c.article_version_id,
            c.quote,
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
      WHERE c.org_id = $1
        AND c.property_id = $2
        AND c.ai_run_id = ANY($3::uuid[])
      ORDER BY c.ai_run_id, c.citation_id`,
    [context.orgId, context.propertyId, [...aiRunIds]],
  );

  for (const citation of citations.rows) {
    const list = byRun.get(citation.ai_run_id) ?? [];
    list.push({
      articleVersionId: citation.article_version_id,
      quote: citation.quote,
      body: citation.body,
      versionNo: citation.version_no,
      topicKey: citation.topic_key,
      title: citation.title,
      isCurrent: citation.is_current,
      promotedAt: citation.promoted_at === null ? null : citation.promoted_at.toISOString(),
    });
    byRun.set(citation.ai_run_id, list);
  }
  return byRun;
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

  const citations = await loadCitations(client, context, [aiRunId]);

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
    citations: citations.get(row.ai_run_id) ?? [],
    handoffs: handoffs.rows.map((handoff) => ({
      reasonCode: handoff.reason_code,
      detail: handoff.detail,
      createdAt: handoff.created_at.toISOString(),
    })),
  };
}
