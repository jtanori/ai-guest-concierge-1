/**
 * S07-03 — request capture, and the reason it exists.
 *
 * The product rule the whole sprint hangs on is one sentence in the plan:
 * *every guest request becomes a tracked, owned, resolved item, and the guest is
 * told the truth about what happened.* Before this module the second half was
 * already true — the catalogue promised a human — and the first half was not:
 * an escalation recorded a `knowledge_gaps` row (for a no-answer) and nothing
 * else, so the guest was told "I've asked the front desk" about a request no
 * queue would ever show.
 *
 * So capture is deliberately dumb and total: one function, one transaction, and
 * every non-answer outcome goes through it. It is not a workflow — S09-01 owns
 * the lifecycle (`new → acknowledged → assigned → resolved`) and S09-05 owns
 * delivery. This module's only job is that the row exists *before* the
 * acknowledgement that promises it, in the same transaction, or the turn fails.
 *
 * ## Why the same transaction is the whole point
 *
 * `captureRequest` is always called inside the caller's transaction (the guest
 * turn, S06-01/`withGuestSession`). If the request row cannot be written, the
 * acknowledgement message is rolled back with it and the guest gets an error
 * rather than a promise. The alternative — commit the message, then try the
 * request — is exactly how a queue loses work while the guest believes a human
 * is on it.
 *
 * ## One open request per conversation
 *
 * A guest who asks three unanswered questions does not have three problems; they
 * have one conversation a human should read. The first capture opens the
 * request, later ones append to it and say so in the event. That also means
 * "how many guests are waiting?" (S08-01) counts conversations, not turns, which
 * is the number an agent can action. The partial index from 0017 makes the
 * lookup cheap.
 */
import type pg from "pg";
import { emitEvent } from "../events/emit.ts";
import type { EventContext } from "../events/taxonomy.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { Lang } from "../i18n/catalog.ts";

/**
 * Stable, machine-readable request topics. Free text here would make the queue
 * ungroupable and any reporting on "what do guests ask for" a text-mining
 * exercise. Extending the list is a deliberate edit, like the reason codes.
 */
export const REQUEST_TOPICS = [
  /** The guest tapped "talk to a person" (S07-02). */
  "guest_requested_human",
  /** The pipeline had nothing to answer from, or the model declined. */
  "unanswered_question",
  /** A human is needed by rule: refunds, medical, allergens, bookings, policy. */
  "needs_human",
  /** Both AI providers failed (S07-05). The guest still gets a request. */
  "ai_unavailable",
] as const;
export type RequestTopic = (typeof REQUEST_TOPICS)[number];

export interface CaptureRequestInput {
  conversationId: string;
  topic: RequestTopic;
  /**
   * The guest's verbatim question, recorded on the knowledge gap. Never on the
   * request: `service_requests` is a queue row, and a queue row that carries
   * guest text ends up in a digest, an email subject and a support ticket.
   */
  question?: string | null;
  language?: Lang | null;
  /** Record a `knowledge_gaps` row with this request (no-answer paths). */
  knowledgeGap?: boolean;
  /** Appendix B reason code, for the event detail. */
  reasonCode?: string | null;
  at?: Date;
}

export interface CapturedRequest {
  requestId: string;
  /** False when an open request already existed for this conversation. */
  created: boolean;
  gapId: string | null;
  /** False when an open gap for the same question already existed. */
  gapCreated: boolean;
}

interface OpenRequestRow {
  request_id: string;
}

interface GapRow {
  gap_id: string;
}

export async function captureRequest(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: CaptureRequestInput,
): Promise<CapturedRequest> {
  const at = input.at ?? new Date();

  const open = await client.query<OpenRequestRow>(
    `SELECT request_id
       FROM service_requests
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
        AND status IN ('new', 'acknowledged', 'assigned')
      LIMIT 1`,
    [context.orgId, context.propertyId, input.conversationId],
  );

  let requestId = open.rows[0]?.request_id;
  const created = requestId === undefined;
  if (requestId === undefined) {
    const inserted = await client.query<OpenRequestRow>(
      `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status)
       VALUES ($1, $2, $3, $4, 'new')
       RETURNING request_id`,
      [context.orgId, context.propertyId, input.conversationId, input.topic],
    );
    requestId = inserted.rows[0]!.request_id;
  }

  let gapId: string | null = null;
  let gapCreated = false;
  if (input.knowledgeGap === true && typeof input.question === "string" && input.question !== "") {
    // The pipeline (S05-02) already writes a gap for an empty retrieval and for
    // the model's own `no_answer`. Capture must not add a second one for the
    // same question — the queue would show the guest twice and the "top gaps"
    // count would double-count the same miss.
    const existing = await client.query<GapRow>(
      `SELECT gap_id
         FROM knowledge_gaps
        WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
          AND question = $4 AND status = 'open'
        LIMIT 1`,
      [context.orgId, context.propertyId, input.conversationId, input.question],
    );
    gapId = existing.rows[0]?.gap_id ?? null;
    if (gapId === null) {
      const inserted = await client.query<GapRow>(
        `INSERT INTO knowledge_gaps (org_id, property_id, conversation_id, question, language, status)
         VALUES ($1, $2, $3, $4, $5, 'open')
         RETURNING gap_id`,
        [context.orgId, context.propertyId, input.conversationId, input.question, input.language ?? null],
      );
      gapId = inserted.rows[0]!.gap_id;
      gapCreated = true;
    }
  }

  const eventContext: EventContext = {
    orgId: context.orgId,
    propertyId: context.propertyId,
    conversationId: input.conversationId,
    channel: "web",
    language: input.language ?? null,
    topic: input.topic,
    createdAt: at.toISOString(),
  };

  if (created) {
    await emitEvent(client, context, "request_created", eventContext, {
      request_id: requestId,
      topic: input.topic,
      ...(input.reasonCode === undefined || input.reasonCode === null
        ? {}
        : { reason_code: input.reasonCode }),
    });
  }
  if (gapCreated && gapId !== null) {
    await emitEvent(client, context, "knowledge_gap_created", eventContext, {
      gap_id: gapId,
      request_id: requestId,
      reason_code: input.reasonCode ?? "low_retrieval",
    });
  }

  return { requestId, created, gapId, gapCreated };
}
