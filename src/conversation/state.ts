/**
 * S06-02 — the conversation state machine, in TypeScript and in SQL.
 *
 * Two copies of one matrix, on purpose:
 *
 *  - `db/migrations/0016_conversation_state.sql` holds the authority, because
 *    the rule must survive raw SQL, background jobs and services that never
 *    import this file.
 *  - this file holds the same matrix so callers get a typed, testable error
 *    WITHOUT a round trip, and so the product's vocabulary lives somewhere a
 *    reviewer reads rather than in a trigger body.
 *
 * A divergence between the two is a bug; `tests/db/conversation-state.db.test.ts`
 * walks every pair in `TRANSITIONS` through the trigger and every pair outside
 * it too, so the copies cannot drift silently.
 *
 * ## What the states mean
 *
 *  - `idle` — nothing is happening; the next guest message may be answered.
 *  - `awaiting_ai` — a guest message is being answered right now.
 *  - `awaiting_staff` — a human owns this conversation. The model may not reply
 *    until a staff member hands it back (`awaiting_staff → awaiting_ai`), which
 *    is the only transition a takeover-aware writer performs on the model's
 *    behalf.
 *  - `resolved` — the conversation was concluded. A new guest message reopens it
 *    (`resolved → awaiting_ai`); it is not a dead end.
 *
 * ## Why the row lock matters (AC-2)
 *
 * `takeover` and the AI's outbound write both do `SELECT ... FOR UPDATE` on the
 * same conversation row, in the same transaction as their other work. That makes
 * the pair mutually exclusive: either the takeover commits first and the AI's
 * re-read sees `awaiting_staff` (so it stays silent), or the AI's turn commits
 * first and the takeover applies to the next message. There is no interleaving
 * where the model finishes a sentence after a human has taken the thread.
 */
import type pg from "pg";
import { emitEvent } from "../events/emit.ts";
import type { EventContext } from "../events/taxonomy.ts";
import type { TenantContext } from "../db/tenant.ts";

export const AI_STATES = ["idle", "awaiting_ai", "awaiting_staff", "resolved"] as const;
export type AiState = (typeof AI_STATES)[number];

/** Mirrors the trigger's matrix exactly. Keep the order for readable diffs. */
export const TRANSITIONS: Readonly<Record<AiState, readonly AiState[]>> = {
  idle: ["awaiting_ai", "awaiting_staff"],
  awaiting_ai: ["idle", "awaiting_staff", "resolved"],
  awaiting_staff: ["resolved", "awaiting_ai"],
  // S07-02: `resolved -> awaiting_staff` is the guest tapping "talk to a
  // person" on a concluded thread. Refusing it would disable the one control
  // that exists to protect a guest, at the moment the bot has already given up.
  // `resolved -> idle` stays illegal: asking for a human must never hand the
  // thread back to the model.
  resolved: ["awaiting_ai", "awaiting_staff"],
} as const;

export class IllegalTransitionError extends Error {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(
      `illegal conversation transition ${from} -> ${to} (allowed from ${from}: ${
        isAiState(from) ? TRANSITIONS[from].join(", ") || "nothing" : "—"
      })`,
    );
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`conversation ${conversationId} not found in this tenant`);
    this.name = "ConversationNotFoundError";
  }
}

/** The model (or its writer) tried to speak while a human owns the thread. */
export class StaffTookOverError extends Error {
  constructor(conversationId: string, state: AiState) {
    super(
      `conversation ${conversationId} is ${state}: a staff takeover owns this thread, ` +
        "so the model must not reply",
    );
    this.name = "StaffTookOverError";
  }
}

export function isAiState(value: unknown): value is AiState {
  return typeof value === "string" && (AI_STATES as readonly string[]).includes(value);
}

export function canTransition(from: AiState, to: AiState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Throws `IllegalTransitionError` rather than returning false: callers forget booleans. */
export function assertTransition(from: AiState, to: AiState): void {
  if (!isAiState(from)) throw new IllegalTransitionError(String(from), String(to));
  if (!isAiState(to)) throw new IllegalTransitionError(from, String(to));
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** States in which the model must stay silent. */
export function modelMaySpeak(state: AiState): boolean {
  return state === "idle" || state === "awaiting_ai" || state === "resolved";
}

interface StateRow {
  ai_state: AiState;
}

/**
 * Reads the state and takes the row lock. Every writer in this module starts
 * here, and the lock is held until the caller's transaction ends — that is the
 * whole of AC-2's atomicity.
 */
export async function lockState(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  conversationId: string,
): Promise<AiState> {
  const result = await client.query<StateRow>(
    `SELECT ai_state
       FROM conversations
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
      FOR UPDATE`,
    [context.orgId, context.propertyId, conversationId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ConversationNotFoundError(conversationId);
  return row.ai_state;
}

/**
 * `FOR UPDATE` + matrix check + UPDATE, in the caller's transaction. The
 * `OR ai_state = $to` in the WHERE clause is what turns a concurrent writer
 * into a no-op instead of a lost update: after the lock is granted we re-check
 * against the row as it is NOW, not as the caller thought it was.
 */
export async function transition(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  conversationId: string,
  to: AiState,
): Promise<AiState> {
  const from = await lockState(client, context, conversationId);
  if (from === to) return to;
  assertTransition(from, to);

  const updated = await client.query<StateRow>(
    `UPDATE conversations
        SET ai_state = $4
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
        AND ai_state = $5
      RETURNING ai_state`,
    [context.orgId, context.propertyId, conversationId, to, from],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    // The lock makes this unreachable in practice; failing loudly beats
    // pretending a transition happened.
    throw new IllegalTransitionError(from, to);
  }
  return row.ai_state;
}

export interface TakeoverInput {
  conversationId: string;
  /** Appendix B reason code, e.g. `guest_asked_human` or `sensitive_topic`. */
  reasonCode: string;
  detail?: string | null;
  /** ISO instant used for the event and the handoff row. */
  at?: Date;
  channel?: "web" | "whatsapp";
  language?: "es" | "en" | null;
}

/**
 * A human claims the conversation. Atomic in the sense that matters: the state
 * change and the `handoff_reasons` row are one transaction, and the lock they
 * take is the same one the model's writer takes before it speaks.
 */
export async function takeover(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: TakeoverInput,
): Promise<AiState> {
  const from = await lockState(client, context, input.conversationId);
  if (from === "awaiting_staff") return from; // idempotent: two agents, one handoff
  assertTransition(from, "awaiting_staff");

  const at = input.at ?? new Date();
  await client.query(
    `UPDATE conversations
        SET ai_state = 'awaiting_staff'
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3`,
    [context.orgId, context.propertyId, input.conversationId],
  );
  await client.query(
    `INSERT INTO handoff_reasons (org_id, property_id, conversation_id, reason_code, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [context.orgId, context.propertyId, input.conversationId, input.reasonCode, input.detail ?? null],
  );

  const eventContext: EventContext = {
    orgId: context.orgId,
    propertyId: context.propertyId,
    conversationId: input.conversationId,
    channel: input.channel ?? "web",
    language: input.language ?? null,
    topic: null,
    createdAt: at.toISOString(),
  };
  await emitEvent(client, context, "human_takeover", eventContext, {
    reason_code: input.reasonCode,
    from_state: from,
  });
  return "awaiting_staff";
}

/**
 * AC-2's guard for the model's own writer: call this immediately before
 * inserting an AI-authored outbound message. It takes the same lock, so a
 * takeover that is waiting to commit will be seen by the re-read that follows.
 */
export async function assertModelMaySpeak(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  conversationId: string,
): Promise<AiState> {
  const state = await lockState(client, context, conversationId);
  if (!modelMaySpeak(state)) throw new StaffTookOverError(conversationId, state);
  return state;
}
