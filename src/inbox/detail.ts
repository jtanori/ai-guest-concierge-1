/**
 * S08-02 — one conversation, with the sources the AI actually used.
 *
 * AC (verbatim): *"Staff can see the cited text verbatim."*
 *
 * - **AC-1** each AI message carries its citations with the exact
 *   `article_version` body/quote that was used.
 * - **AC-2** editing the article later does not change what staff see for an
 *   old answer.
 *
 * AC-2 is the interesting one, and it is not a property of this file: it is a
 * property of the schema. `article_versions` are append-only (0003), and a
 * citation points at a version id, never at an article (D5). Editing an article
 * publishes a NEW version; the old row keeps its body forever. So this module
 * does the one thing that could still break the promise — it reads the body
 * from `article_versions` and never from `knowledge_articles` — and a test
 * proves it by publishing a second version after the answer and re-reading.
 *
 * Why the quote column exists: S05-03 could only show the whole body, which
 * meant a staff member hunting for one sentence in a 19,000-character
 * noticeboard while a guest waits. 0022 stores the sentence the model quoted
 * (already proven to appear in that version by `src/ai/guard.ts`), so the pane
 * can show the anchor first and the body second. Citations written before 0022
 * have `quote = NULL` and fall back to the body — not an error, just history.
 *
 * What this does NOT do: it does not decide anything, write anything, or call a
 * model. It is a read for a human, and every query carries the tenant predicate
 * explicitly in addition to RLS.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import type { StaffSession } from "../auth/context.ts";
import { loadCitations, type ReconstructedCitation } from "../ai/history.ts";

export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    // Deliberately identical for "does not exist" and "belongs to someone
    // else": a 404 that says which would be an existence oracle.
    super(`conversation ${conversationId} was not found in this tenant`);
    this.name = "ConversationNotFoundError";
  }
}

/** The last N messages. A staff member reads the end of a conversation. */
export const DETAIL_MESSAGE_LIMIT = 100;

export interface DetailAiRun {
  aiRunId: string;
  modelId: string;
  promptVersion: string;
  decision: "answer" | "escalate" | "no_answer";
  reasonCode: string | null;
  confidence: number | null;
  latencyMs: number | null;
  /** Every citation of THIS answer, with its quote and the version body. */
  citations: ReconstructedCitation[];
}

export interface DetailMessage {
  messageId: string;
  direction: "inbound" | "outbound";
  authorRole: "guest" | "ai" | "staff";
  /**
   * The raw text, exactly as stored. Escaping is the renderer's job (React
   * escapes by default); doing it here would corrupt the transcript for every
   * non-HTML consumer and hide the difference between "the guest typed
   * <script>" and "the guest typed &lt;script&gt;".
   */
  body: string;
  createdAt: string;
  /** Null for guest/staff messages, and for AI messages written before S05-03. */
  aiRun: DetailAiRun | null;
}

export interface DetailRequest {
  requestId: string;
  status: string;
  topic: string | null;
  createdAt: string;
}

export interface ConversationDetail {
  conversationId: string;
  aiState: string;
  status: string;
  language: string | null;
  /**
   * The property's IANA zone, so the screen can render hotel-local times. The
   * server has no idea where the reader is, and a front desk reading UTC
   * timestamps is a front desk mis-reading a wait time.
   */
  timeZone: string;
  createdAt: string;
  lastActivityAt: string;
  /** Chronological: the transcript reads top to bottom. */
  messages: DetailMessage[];
  requests: DetailRequest[];
}

interface ConversationRow {
  time_zone: string;
  conversation_id: string;
  ai_state: string;
  status: string;
  language: string | null;
  created_at: Date;
  last_activity_at: Date;
}

interface MessageRow {
  message_id: string;
  direction: "inbound" | "outbound";
  author_role: "guest" | "ai" | "staff";
  body: string;
  created_at: Date;
}

interface RunRow {
  ai_run_id: string;
  message_id: string | null;
  model_id: string;
  prompt_version: string;
  decision: "answer" | "escalate" | "no_answer";
  reason_code: string | null;
  confidence: string | null;
  latency_ms: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One conversation, its transcript, and the sources behind each AI answer.
 *
 * Four queries, not one per message: the messages, the runs for those messages,
 * the citations for those runs (batched through the one join D5 is allowed to
 * have), and the requests. A `reconstructAnswer` call per AI message would be
 * three queries each and would still be the same SQL — this is what "reuse the
 * join, not the loop" looks like.
 */
export async function getConversationDetail(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  conversationId: string,
): Promise<ConversationDetail> {
  session.requireRole("queue", "read");
  assertTenantShape(context);
  if (!UUID_RE.test(conversationId)) throw new ConversationNotFoundError(conversationId);

  const conversation = await client.query<ConversationRow>(
    `SELECT c.conversation_id, c.ai_state, c.status, c.language,
            c.created_at, c.last_activity_at, p.time_zone
       FROM conversations c
       JOIN properties p
         ON p.org_id = c.org_id AND p.property_id = c.property_id
      WHERE c.org_id = $1 AND c.property_id = $2 AND c.conversation_id = $3`,
    [context.orgId, context.propertyId, conversationId],
  );
  const head = conversation.rows[0];
  if (head === undefined) throw new ConversationNotFoundError(conversationId);

  // Newest first for the LIMIT, then reversed: a long conversation should show
  // its end, and `ORDER BY created_at ASC LIMIT 100` would show its beginning.
  const messages = await client.query<MessageRow>(
    `SELECT message_id, direction, author_role, body, created_at
       FROM messages
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
      ORDER BY created_at DESC, message_id DESC
      LIMIT $4`,
    [context.orgId, context.propertyId, conversationId, DETAIL_MESSAGE_LIMIT],
  );
  const ordered = [...messages.rows].reverse();

  const run = await client.query<RunRow>(
    `SELECT ai_run_id, message_id, model_id, prompt_version, decision,
            reason_code, confidence, latency_ms
       FROM ai_runs
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
      ORDER BY created_at`,
    [context.orgId, context.propertyId, conversationId],
  );
  const citations = await loadCitations(
    client,
    context,
    run.rows.map((row) => row.ai_run_id),
  );
  const runByMessage = new Map<string, DetailAiRun>();
  for (const row of run.rows) {
    if (row.message_id === null) continue;
    runByMessage.set(row.message_id, {
      aiRunId: row.ai_run_id,
      modelId: row.model_id,
      promptVersion: row.prompt_version,
      decision: row.decision,
      reasonCode: row.reason_code,
      confidence: row.confidence === null ? null : Number(row.confidence),
      latencyMs: row.latency_ms,
      citations: citations.get(row.ai_run_id) ?? [],
    });
  }

  const requests = await client.query<{
    request_id: string;
    status: string;
    topic: string | null;
    created_at: Date;
  }>(
    `SELECT request_id, status, topic, created_at
       FROM service_requests
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
      ORDER BY created_at`,
    [context.orgId, context.propertyId, conversationId],
  );

  return {
    conversationId: head.conversation_id,
    aiState: head.ai_state,
    status: head.status,
    language: head.language,
    timeZone: head.time_zone,
    createdAt: head.created_at.toISOString(),
    lastActivityAt: head.last_activity_at.toISOString(),
    messages: ordered.map((message) => ({
      messageId: message.message_id,
      direction: message.direction,
      authorRole: message.author_role,
      body: message.body,
      createdAt: message.created_at.toISOString(),
      aiRun: runByMessage.get(message.message_id) ?? null,
    })),
    requests: requests.rows.map((request) => ({
      requestId: request.request_id,
      status: request.status,
      topic: request.topic,
      createdAt: request.created_at.toISOString(),
    })),
  };
}
