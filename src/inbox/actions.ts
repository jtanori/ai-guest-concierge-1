/**
 * S08-03 — reply, take over, assign, resolve.
 *
 * AC (verbatim): *"No race where AI replies after a takeover."*
 *
 * - **AC-1** the four actions are atomic under a `FOR UPDATE` conversation lock.
 * - **AC-2** an AI writer that started before a takeover loses the race
 *   deterministically.
 *
 * AC-1 is the easy half: every function here starts by locking the conversation
 * row, re-reads the state from the locked row — never from the copy the route read
 * a moment ago — and only then writes. The lock is held until the
 * staff transaction commits, so two agents clicking "take over" on the same
 * conversation are serialised by the database, not by hope.
 *
 * AC-2 is the half that lives elsewhere: `src/ai/answer.ts` stops holding the
 * conversation lock across the model call, so a takeover can commit *while* the
 * model is thinking, and the model's write re-checks the state under the same
 * lock before it speaks. This module supplies the far side of that pair — the
 * `takeover()` it calls is the one in `src/conversation/state.ts` that the AI
 * writer also uses, not a second implementation.
 *
 * ## Why a staff reply takes over
 *
 * `reply` moves the conversation to `awaiting_staff` as part of its transaction
 * unless a human already owns it. A staff message *is* a takeover in the only
 * sense that matters to a guest, and pretending otherwise would create a window
 * where a human typed an answer and the model answered over the top of it. The
 * one place that would be wrong is a hotel that wants the model to keep
 * answering alongside staff — that is S08-04's operating modes, not this item.
 *
 * ## What is deliberately not here
 *
 * No email, no push, no Slack (S09-05). No operating modes (S08-04). No
 * "reopen" action: a guest message reopens a resolved conversation by itself
 * (`resolved → awaiting_ai`, 0017).
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import type { StaffSession } from "../auth/context.ts";
import { writeAudit } from "../audit/write.ts";
import { emitEvent } from "../events/emit.ts";
import type { EventContext } from "../events/taxonomy.ts";
import { LANGUAGES, type Lang } from "../i18n/catalog.ts";
import { takeover, transition, type AiState } from "../conversation/state.ts";
import { ConversationNotFoundError } from "./detail.ts";

export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

/** The request the caller asked about is not this conversation's, or is closed. */
export class RequestNotActionableError extends Error {
  constructor(
    readonly reason: "not_found" | "not_open",
    message: string,
  ) {
    super(message);
    this.name = "RequestNotActionableError";
  }
}

export class AssigneeNotMemberError extends Error {
  constructor(userId: string) {
    super(`user ${userId} is not a member of this property`);
    this.name = "AssigneeNotMemberError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guest messages are capped at this (S07-01); staff are held to the same bound. */
export const MAX_STAFF_MESSAGE_CHARS = 2000;

const OPEN_STATUSES = ["new", "acknowledged", "assigned"] as const;

interface ConversationHead {
  ai_state: AiState;
  language: Lang | null;
}

/**
 * The lock plus the head of the row every action needs.
 *
 * `lockState` returns the state but not the language; reading both in one
 * statement keeps the lock and the facts taken under it consistent, and avoids a
 * second round trip inside a transaction an agent is waiting on.
 *
 * The mode is `FOR NO KEY UPDATE` rather than `FOR UPDATE` for the reason
 * documented in `src/conversation/state.ts`: an in-flight guest turn holds a
 * `FOR KEY SHARE` lock on this row (its inbound message's foreign key), and
 * `FOR UPDATE` would make every staff action wait behind a model call. Staff
 * actions still exclude each other, and the model's own writer still takes the
 * stronger lock, so the loser is always the bot.
 */
async function lockConversation(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  conversationId: string,
): Promise<ConversationHead> {
  if (!UUID.test(conversationId)) throw new ConversationNotFoundError(conversationId);
  const result = await client.query<{ ai_state: AiState; language: string | null }>(
    `SELECT ai_state, language
       FROM conversations
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
      FOR NO KEY UPDATE`,
    [context.orgId, context.propertyId, conversationId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ConversationNotFoundError(conversationId);
  const language = LANGUAGES.includes(row.language as Lang) ? (row.language as Lang) : null;
  return { ai_state: row.ai_state, language };
}

async function insertStaffMessage(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: { conversationId: string; body: string; language: Lang | null },
): Promise<{ messageId: string; createdAt: string }> {
  // `created_at` is taken from the database clock, like every other message: a
  // staff phone with a skewed clock must not appear to answer before the guest
  // asked.
  const inserted = await client.query<{ message_id: string; created_at: Date }>(
    `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body, language)
     VALUES ($1, $2, $3, 'outbound', 'staff', $4, $5)
     RETURNING message_id, created_at`,
    [context.orgId, context.propertyId, input.conversationId, input.body, input.language],
  );
  const row = inserted.rows[0]!;
  await client.query(
    "UPDATE conversations SET last_activity_at = $4::timestamptz WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3",
    [context.orgId, context.propertyId, input.conversationId, row.created_at],
  );
  return { messageId: row.message_id, createdAt: row.created_at.toISOString() };
}

function eventContext(
  context: TenantContext,
  conversationId: string,
  language: Lang | null,
  at: Date,
): EventContext {
  return {
    orgId: context.orgId,
    propertyId: context.propertyId,
    conversationId,
    channel: "web",
    language,
    topic: null,
    createdAt: at.toISOString(),
  };
}

export interface TakeOverResult {
  aiState: AiState;
  /** True when the human already owned it — a retry, not a second handoff. */
  alreadyOwned: boolean;
}

/**
 * A human claims the thread.
 *
 * Delegates to `takeover()` in `src/conversation/state.ts` rather than writing
 * `awaiting_staff` here: that function is the one the guest pipeline also calls,
 * and a second writer of the same state is a second place for the transition
 * matrix to be wrong. What this adds is the actor — the audit row names the
 * person, which the guest path cannot do.
 */
export async function takeOverConversation(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  input: { conversationId: string; detail?: string | null },
): Promise<TakeOverResult> {
  session.requireRole("queue", "write");
  assertTenantShape(context);
  const head = await lockConversation(client, context, input.conversationId);

  if (head.ai_state === "awaiting_staff") {
    return { aiState: "awaiting_staff", alreadyOwned: true };
  }

  const at = new Date();
  const aiState = await takeover(client, context, {
    conversationId: input.conversationId,
    reasonCode: "staff_takeover",
    detail: input.detail ?? null,
    at,
    channel: "web",
    language: head.language,
  });

  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: session.userUuid,
    action: "conversation.takeover",
    entityType: "conversation",
    entityId: input.conversationId,
    detail: { from_state: head.ai_state, reason_code: "staff_takeover" },
  });

  return { aiState, alreadyOwned: false };
}

export interface ReplyResult {
  messageId: string;
  createdAt: string;
  aiState: AiState;
}

/**
 * A staff message, which also claims the thread.
 *
 * The takeover happens *first*, under the same lock and in the same transaction
 * as the message: if it happened after, the model could answer in the gap, and
 * the guest would see the bot reply and then a human reply to the same question.
 */
export async function replyToConversation(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  input: { conversationId: string; body: string },
): Promise<ReplyResult> {
  session.requireRole("queue", "write");
  assertTenantShape(context);

  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body === "") throw new ActionInputError("message body is required");
  if (body.length > MAX_STAFF_MESSAGE_CHARS) {
    throw new ActionInputError(
      `message body is longer than ${MAX_STAFF_MESSAGE_CHARS} characters`,
    );
  }

  const head = await lockConversation(client, context, input.conversationId);
  const at = new Date();

  if (head.ai_state !== "awaiting_staff") {
    await takeover(client, context, {
      conversationId: input.conversationId,
      reasonCode: "staff_takeover",
      detail: "staff replied",
      at,
      channel: "web",
      language: head.language,
    });
    await writeAudit(client, {
      orgId: context.orgId,
      propertyId: context.propertyId,
      actorUserId: session.userUuid,
      action: "conversation.takeover",
      entityType: "conversation",
      entityId: input.conversationId,
      detail: { from_state: head.ai_state, reason_code: "staff_takeover", via: "reply" },
    });
  }

  const message = await insertStaffMessage(client, context, {
    conversationId: input.conversationId,
    body,
    language: head.language,
  });

  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: session.userUuid,
    action: "message.sent",
    entityType: "message",
    entityId: message.messageId,
    detail: { conversation_id: input.conversationId, characters: body.length },
  });
  await emitEvent(client, context, "staff_message_sent", eventContext(context, input.conversationId, head.language, at), {
    message_id: message.messageId,
    characters: body.length,
  });

  return { ...message, aiState: "awaiting_staff" };
}

const REQUEST_ROW_SQL = `
  SELECT request_id, status, topic, conversation_id
    FROM service_requests
   WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
   ORDER BY created_at DESC`;

export interface AssignResult {
  requestId: string;
  assignedTo: string;
  /** False when the same person was already assigned — a replay, not a change. */
  created: boolean;
}

/**
 * Assign an open request. `assigneeUserId` defaults to the caller ("assign to
 * me", which is what an agent does when they pick something up).
 *
 * The duplicate guard is the unique index in 0023 — not a SELECT-then-INSERT,
 * which is the classic read-then-write race with a second agent in the same
 * millisecond. A replay returns `created: false` and emits nothing, because
 * "assigned twice" is not a thing that happened.
 */
export async function assignRequest(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  input: { conversationId: string; requestId?: string | null; assigneeUserId?: string | null },
): Promise<AssignResult> {
  session.requireRole("queue", "write");
  assertTenantShape(context);
  const head = await lockConversation(client, context, input.conversationId);

  const requestId = await openRequestId(client, context, input.conversationId, input.requestId ?? null);
  const assignee = input.assigneeUserId ?? session.userUuid;
  if (!UUID.test(assignee)) throw new ActionInputError("assigneeUserId must be a uuid");

  const member = await client.query(
    "SELECT 1 FROM memberships WHERE property_id = $1 AND user_id = $2",
    [context.propertyId, assignee],
  );
  if (member.rowCount === 0) throw new AssigneeNotMemberError(assignee);

  const inserted = await client.query<{ assignment_id: string }>(
    `INSERT INTO assignments (org_id, property_id, request_id, assigned_to)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, property_id, request_id, assigned_to) DO NOTHING
     RETURNING assignment_id`,
    [context.orgId, context.propertyId, requestId, assignee],
  );

  await client.query(
    `UPDATE service_requests
        SET status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END
      WHERE org_id = $1 AND property_id = $2 AND request_id = $3`,
    [context.orgId, context.propertyId, requestId],
  );

  const created = inserted.rowCount === 1;
  if (created) {
    await emitEvent(client, context, "request_assigned", eventContext(context, input.conversationId, head.language, new Date()), {
      request_id: requestId,
      assigned_to: assignee,
      assignment_id: inserted.rows[0]!.assignment_id,
    });
  }

  return { requestId, assignedTo: assignee, created };
}

export interface ResolveResult {
  /** Every request this closed. Usually one; a conversation can have opened more. */
  requestIds: string[];
  /** The first closed request, kept for callers that only care about "the" one. */
  requestId: string | null;
  aiState: AiState;
}

/**
 * Close the conversation and, if it opened a request, close that too.
 *
 * Both in one transaction under one lock: a request left `assigned` on a resolved
 * conversation is the row a hotel loses (S08-01's `unresolved` filter exists
 * because of it).
 */
export async function resolveConversation(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  input: { conversationId: string; requestId?: string | null },
): Promise<ResolveResult> {
  session.requireRole("queue", "write");
  assertTenantShape(context);
  const head = await lockConversation(client, context, input.conversationId);
  const at = new Date();

  // Close EVERY open request on the thread, not just the newest. "Resolve" is
  // about the conversation; leaving a second request `assigned` behind is exactly
  // the row S08-01's `unresolved` filter exists to surface, and the agent who just
  // closed the thread is the last person who will look at it.
  let requestIds: string[] = [];
  if (input.requestId !== undefined && input.requestId !== null) {
    requestIds = [await openRequestId(client, context, input.conversationId, input.requestId)];
  } else {
    const open = await client.query<{ request_id: string }>(
      `SELECT request_id
         FROM service_requests
        WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
          AND status = ANY($4::text[])
        ORDER BY created_at`,
      [context.orgId, context.propertyId, input.conversationId, [...OPEN_STATUSES]],
    );
    requestIds = open.rows.map((row) => row.request_id);
  }

  for (const requestId of requestIds) {
    await client.query(
      `UPDATE service_requests
          SET status = 'resolved', resolved_at = $4::timestamptz
        WHERE org_id = $1 AND property_id = $2 AND request_id = $3`,
      [context.orgId, context.propertyId, requestId, at],
    );
    await emitEvent(client, context, "request_resolved", eventContext(context, input.conversationId, head.language, at), {
      request_id: requestId,
    });
  }

  // `resolved -> resolved` is legal (`canTransition` returns true for identity),
  // so closing an already-closed thread is a no-op instead of an error.
  const aiState = await transition(client, context, input.conversationId, "resolved");
  return { requestId: requestIds[0] ?? null, requestIds, aiState };
}

/**
 * The request to act on, validated to belong to this conversation and still open.
 *
 * Kept as one function because both callers need the same three checks, and the
 * failure mode of writing them twice is a route that silently accepts another
 * conversation's request id.
 */
async function openRequestId(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  conversationId: string,
  requested: string | null,
): Promise<string> {
  const rows = await client.query<{ request_id: string; status: string }>(REQUEST_ROW_SQL, [
    context.orgId,
    context.propertyId,
    conversationId,
  ]);

  if (requested !== null) {
    const match = rows.rows.find((row) => row.request_id === requested);
    if (match === undefined) {
      throw new RequestNotActionableError(
        "not_found",
        `request ${requested} does not belong to this conversation`,
      );
    }
    if (!(OPEN_STATUSES as readonly string[]).includes(match.status)) {
      throw new RequestNotActionableError("not_open", `request ${requested} is ${match.status}`);
    }
    return match.request_id;
  }

  const open = rows.rows.find((row) => (OPEN_STATUSES as readonly string[]).includes(row.status));
  if (open === undefined) {
    throw new RequestNotActionableError("not_found", "this conversation has no open request");
  }
  return open.request_id;
}
