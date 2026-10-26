/**
 * S06-01 — one guest turn, start to finish.
 *
 * `postGuestMessage` is the whole product loop for the pilot surface: a stranger
 * types something, the answer pipeline (S05) runs, and BOTH messages exist in
 * the database — the guest's verbatim words and the exact text that was sent
 * back. Everything happens in one transaction (`withGuestSession`), so a
 * failure at any step leaves no half-conversation: no inbound message without
 * its answer, no answer attributed to a conversation that was not created.
 *
 * Decisions worth naming:
 *
 *  - **The transcript is the database, not the browser.** The client sends text
 *    and keeps a signed cookie; it never sends a conversation id, an identity
 *    id or a tenant. History is read back from `messages` under RLS.
 *  - **A new conversation is created here, not by the client.** The cookie's
 *    `conversationId` is honoured only if the row exists, belongs to THIS
 *    tenant, belongs to THIS identity and is still open. Anything else starts a
 *    fresh conversation — a guest who clears cookies loses nothing but the
 *    thread, and cannot resume someone else's.
 *  - **The AI's failure is not the guest's failure.** `unavailable` (both
 *    providers down) still persists an outbound message: the honest
 *    "a person will reply" string from the catalogue, never a 500 and never
 *    silence.
 *  - **The reply is the AI output's `answer` only when the guardrail let it
 *    through.** Every branch reads its text from the pipeline's outcome, so the
 *    text persisted here is the text that was verified (S05-02), not something
 *    re-composed at the edge.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { answerMessage, type AnswerOutcome } from "../ai/answer.ts";
import { AiUnavailableError, type ResilientAi } from "../ai/provider.ts";
import type { Channel, EventContext } from "../events/taxonomy.ts";
import { emitEvent } from "../events/emit.ts";
import { lockState, transition } from "../conversation/state.ts";
import { t, type Lang } from "../i18n/catalog.ts";
import type { TenantContext } from "../db/tenant.ts";
import { signGuestTicket, type GuestTicket } from "./cookie.ts";
import {
  UnknownPropertyError,
  withGuestSession,
  type GuestSession,
  type PublicProperty,
} from "./session.ts";

export class GuestInputError extends Error {}

/** A message long enough to be a paste of the manual is not a question. */
export const MAX_MESSAGE_CHARS = 2_000;
/** How much history a transcript read returns (newest last). */
export const TRANSCRIPT_LIMIT = 50;

export interface GuestDeps {
  /** Resilient AI (S05-01). Injected so tests own what the model says. */
  ai: ResilientAi;
  /** HMAC key for the identity cookie (`loadGuestConfig`). */
  cookieSecret: string;
  /** Optional question embedding (DEC-3); omitted means no vector branch. */
  embed?: (text: string) => Promise<number[]>;
  /** Guest's clock, for after-hours policy. Injected so tests can pin it. */
  now?: () => Date;
}

export interface GuestMessage {
  messageId: string;
  direction: "inbound" | "outbound";
  authorRole: "guest" | "ai" | "staff";
  body: string;
  createdAt: string;
}

export interface PublicPropertyView {
  slug: string;
  name: string;
  languages: string[];
  disclosure: string;
  talkToPerson: string;
}

export interface GuestTurn {
  property: PublicPropertyView;
  conversationId: string;
  /** Re-issued cookie value: the server signs, the browser only carries it. */
  ticket: string;
  messages: GuestMessage[];
  decision: "answer" | "fact" | "escalate" | "no_answer" | "unavailable" | "handoff";
  reasonCode: string | null;
  language: Lang;
}

export interface GuestTranscript {
  property: PublicPropertyView;
  conversationId: string | null;
  messages: GuestMessage[];
}

function normaliseLanguage(value: string | null | undefined, fallback: Lang): Lang {
  if (value === "es" || value === "en") return value;
  return fallback;
}

/** The property's first declared language, or `es` — the pilot's market. */
function defaultLanguage(property: PublicProperty): Lang {
  const first = property.languages.find((code) => code === "es" || code === "en");
  return first === "es" || first === "en" ? first : "es";
}

function propertyView(property: PublicProperty, language: Lang): PublicPropertyView {
  return {
    slug: property.slug,
    name: property.name,
    languages: property.languages,
    disclosure: t("guest.ai_disclosure", language),
    talkToPerson: t("guest.talk_to_person", language),
  };
}

interface MessageRow {
  message_id: string;
  direction: "inbound" | "outbound";
  author_role: "guest" | "ai" | "staff";
  body: string;
  created_at: Date | string;
}

function toMessage(row: MessageRow): GuestMessage {
  return {
    messageId: row.message_id,
    direction: row.direction,
    authorRole: row.author_role,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * The web channel connection is created on first contact. `channel_connections`
 * is unique per (property, channel), so the upsert is safe under concurrency and
 * does not need a seed step to have run.
 */
async function webConnectionId(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<string> {
  const result = await client.query<{ channel_connection_id: string }>(
    `WITH inserted AS (
       INSERT INTO channel_connections (org_id, property_id, channel)
       VALUES ($1, $2, 'web')
       ON CONFLICT (property_id, channel) DO NOTHING
       RETURNING channel_connection_id
     )
     SELECT channel_connection_id FROM inserted
     UNION ALL
     SELECT channel_connection_id
       FROM channel_connections
      WHERE org_id = $1 AND property_id = $2 AND channel = 'web'
     LIMIT 1`,
    [context.orgId, context.propertyId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("could not resolve the web channel connection");
  return row.channel_connection_id;
}

/**
 * The identity is anonymous either way: an unknown external id is generated, and
 * the cookie is the only thing that maps back to it. A ticket from another
 * property is treated as absent (not as an error) — cookies outlive deployments
 * and a guest who visits two hotels should not be shown a failure.
 */
async function resolveIdentity(
  client: pg.Client | pg.PoolClient,
  session: GuestSession,
  ticket: GuestTicket | null,
  conversationLanguage: Lang,
): Promise<{ identityId: string; connectionId: string; created: boolean }> {
  const { context } = session;
  if (ticket !== null && ticket.propertyId === context.propertyId) {
    const existing = await client.query<{ identity_id: string; connection_id: string }>(
      `SELECT identity_id, connection_id FROM channel_identities WHERE identity_id = $1`,
      [ticket.identityId],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      return { identityId: row.identity_id, connectionId: row.connection_id, created: false };
    }
  }

  const connectionId = await webConnectionId(client, context);
  const created = await client.query<{ identity_id: string }>(
    `INSERT INTO channel_identities (org_id, property_id, connection_id, external_id, language)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING identity_id`,
    [context.orgId, context.propertyId, connectionId, `web:${randomUUID()}`, conversationLanguage],
  );
  return {
    identityId: created.rows[0]!.identity_id,
    connectionId,
    created: true,
  };
}

/** Reuse a ticket's conversation only when it is this tenant's, this guest's and open. */
async function resolveConversation(
  client: pg.Client | pg.PoolClient,
  session: GuestSession,
  ticket: GuestTicket | null,
  identity: { identityId: string; connectionId: string },
  language: Lang,
): Promise<{ conversationId: string; created: boolean }> {
  const { context } = session;
  if (ticket !== null && ticket.conversationId !== null) {
    const existing = await client.query<{ conversation_id: string }>(
      `SELECT conversation_id
         FROM conversations
        WHERE conversation_id = $1 AND identity_id = $2 AND status = 'open'`,
      [ticket.conversationId, identity.identityId],
    );
    const row = existing.rows[0];
    if (row !== undefined) return { conversationId: row.conversation_id, created: false };
  }

  const created = await client.query<{ conversation_id: string }>(
    `INSERT INTO conversations (org_id, property_id, connection_id, identity_id, language)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING conversation_id`,
    [context.orgId, context.propertyId, identity.connectionId, identity.identityId, language],
  );
  return { conversationId: created.rows[0]!.conversation_id, created: true };
}

interface InsertedMessage {
  messageId: string;
  createdAt: string;
}

async function insertMessage(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: {
    conversationId: string;
    direction: "inbound" | "outbound";
    authorRole: "guest" | "ai";
    body: string;
    language: Lang;
  },
): Promise<InsertedMessage> {
  const result = await client.query<{ message_id: string; created_at: Date | string }>(
    // `clock_timestamp()`, not the column default: both messages of a turn are
    // written inside ONE transaction, and `now()` is the transaction's start
    // time, so the inbound and the outbound row would tie to the microsecond and
    // any "order by created_at" would fall back to a random UUID.
    `INSERT INTO messages
       (org_id, property_id, conversation_id, direction, author_role, body, language, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
     RETURNING message_id, created_at`,
    [
      context.orgId,
      context.propertyId,
      input.conversationId,
      input.direction,
      input.authorRole,
      input.body,
      input.language,
    ],
  );
  const row = result.rows[0]!;
  return { messageId: row.message_id, createdAt: new Date(row.created_at).toISOString() };
}

/**
 * The outbound text for one pipeline outcome. A single place, because "what does
 * the guest see" must never be decided twice: the verified answer for a model
 * answer, the verified fact's value for a fact, and a catalogue string for
 * everything else — including the outage path.
 */
export function replyFor(outcome: AnswerOutcome, language: Lang): { body: string; decision: GuestTurn["decision"] } {
  switch (outcome.kind) {
    case "answer":
      return { body: outcome.output.answer ?? "", decision: "answer" };
    case "fact":
      // A verified fact is a value, not a sentence; the prefix is catalogue
      // copy so the guest never sees a bare "20:00".
      return { body: `${t("guest.fact_prefix", language)}${outcome.fact.value}`, decision: "fact" };
    case "no_answer":
      return { body: outcome.guestMessage, decision: "no_answer" };
    case "escalate":
      return { body: outcome.guestMessage, decision: "escalate" };
    case "unavailable":
      return { body: t("guest.unavailable", language), decision: "unavailable" };
  }
}

function reasonFor(outcome: AnswerOutcome): string | null {
  switch (outcome.kind) {
    case "answer":
    case "fact":
      return null;
    case "no_answer":
      return outcome.reasonCode;
    case "escalate":
      return outcome.reasonCode;
    case "unavailable":
      return "ai_unavailable";
  }
}

async function askModel(
  deps: GuestDeps,
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: {
    conversationId: string;
    messageId: string;
    text: string;
    language: Lang;
    channel: Channel;
    at: Date;
  },
): Promise<AnswerOutcome> {
  let embedding: number[] | undefined;
  if (deps.embed !== undefined) {
    try {
      embedding = await deps.embed(input.text);
    } catch {
      // Retrieval without the vector branch is worse, not broken. A failed
      // embedding must not cost the guest an answer that lexical retrieval can
      // still support.
      embedding = undefined;
    }
  }
  try {
    return await answerMessage(
      client,
      context,
      {
        conversationId: input.conversationId,
        messageId: input.messageId,
        text: input.text,
        language: input.language,
        channel: input.channel,
        at: input.at,
        ...(embedding === undefined ? {} : { embedding }),
      },
      { ai: deps.ai },
    );
  } catch (error) {
    // `answerMessage` maps both-providers-failed to `unavailable`; this is the
    // belt-and-braces case (an adapter that throws outside the wrapper). The
    // guest still gets an honest sentence instead of a 500.
    if (error instanceof AiUnavailableError) {
      return { kind: "unavailable", detail: error.message };
    }
    throw error;
  }
}

/**
 * One turn. Returns the two messages, the reply and a re-signed ticket.
 * Throws `UnknownPropertyError` (404) for a slug that resolves to nothing and
 * `GuestInputError` (400) for text the guest could not have meant to send.
 */
export async function postGuestMessage(
  deps: GuestDeps,
  client: pg.Client | pg.PoolClient,
  input: { slug: string; text: string; language?: string | null; ticket?: GuestTicket | null },
): Promise<GuestTurn> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text === "") throw new GuestInputError("message text is required");
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new GuestInputError(`message text is longer than ${MAX_MESSAGE_CHARS} characters`);
  }
  const at = (deps.now ?? (() => new Date()))();

  return withGuestSession(client, input.slug, async (session, scoped) => {
    const language = normaliseLanguage(input.language, defaultLanguage(session.property));
    const identity = await resolveIdentity(scoped, session, input.ticket ?? null, language);
    const conversation = await resolveConversation(
      scoped,
      session,
      input.ticket ?? null,
      identity,
      language,
    );

    // S06-02: take the conversation's row lock for the REST of this transaction.
    // Everything below — the model call, the outbound message, the state write —
    // happens under it, which is what makes a concurrent staff takeover and this
    // turn mutually exclusive rather than merely unlikely.
    const state = await lockState(scoped, session.context, conversation.conversationId);

    const eventBase: EventContext = {
      orgId: session.context.orgId,
      propertyId: session.context.propertyId,
      conversationId: conversation.conversationId,
      channel: "web",
      language,
      topic: null,
      createdAt: at.toISOString(),
    };

    if (conversation.created) {
      await emitEvent(scoped, session.context, "conversation_started", eventBase, {
        channel: "web",
        anonymous: true,
      });
    }

    const inbound = await insertMessage(scoped, session.context, {
      conversationId: conversation.conversationId,
      direction: "inbound",
      authorRole: "guest",
      body: text,
      language,
    });
    await emitEvent(scoped, session.context, "message_received", eventBase, {
      message_id: inbound.messageId,
      characters: text.length,
    });

    // A human owns this thread: record the guest's words, answer honestly that
    // someone will reply, and do NOT call the model. This is the state S08's
    // inbox produces and S08-03 depends on.
    if (state === "awaiting_staff") {
      const pending = t("guest.staff_reply_pending", language);
      const outbound = await insertMessage(scoped, session.context, {
        conversationId: conversation.conversationId,
        direction: "outbound",
        authorRole: "ai",
        body: pending,
        language,
      });
      await scoped.query(
        `UPDATE conversations SET last_activity_at = $2::timestamptz WHERE conversation_id = $1`,
        [conversation.conversationId, outbound.createdAt],
      );
      return finish("handoff", "awaiting_staff", { ...outbound, body: pending });
    }

    // The model is about to speak, so the conversation is no longer idle. A
    // `resolved` thread reopens here rather than staying a dead end.
    await transition(scoped, session.context, conversation.conversationId, "awaiting_ai");

    const outcome = await askModel(deps, scoped, session.context, {
      conversationId: conversation.conversationId,
      messageId: inbound.messageId,
      text,
      language,
      channel: "web",
      at,
    });
    const reply = replyFor(outcome, language);
    const outbound = await insertMessage(scoped, session.context, {
      conversationId: conversation.conversationId,
      direction: "outbound",
      authorRole: "ai",
      body: reply.body,
      language,
    });

    await scoped.query(
      `UPDATE conversations SET last_activity_at = $2::timestamptz WHERE conversation_id = $1`,
      [conversation.conversationId, outbound.createdAt],
    );

    // An answer returns the thread to `idle`; anything that needs a human parks
    // it in `awaiting_staff` so the next turn (and S08's queue) knows the model
    // has stepped back.
    await transition(
      scoped,
      session.context,
      conversation.conversationId,
      reply.decision === "answer" || reply.decision === "fact" ? "idle" : "awaiting_staff",
    );

    return finish(reply.decision, reasonFor(outcome), { ...outbound, body: reply.body });

    /**
     * Shared tail: the ticket, the wire shape and the language. Written as a
     * closure so the handoff path cannot forget to sign the cookie — the first
     * version of this function had the ticket assembly twice.
     */
    function finish(
      decision: GuestTurn["decision"],
      reasonCode: string | null,
      outbound: InsertedMessage & { body: string },
    ): GuestTurn {
      return {
        property: propertyView(session.property, language),
        conversationId: conversation.conversationId,
        ticket: signGuestTicket(
          {
            identityId: identity.identityId,
            conversationId: conversation.conversationId,
            propertyId: session.context.propertyId,
          },
          deps.cookieSecret,
        ),
        messages: [
          {
            messageId: inbound.messageId,
            direction: "inbound",
            authorRole: "guest",
            body: text,
            createdAt: inbound.createdAt,
          },
          {
            messageId: outbound.messageId,
            direction: "outbound",
            authorRole: "ai",
            body: outbound.body,
            createdAt: outbound.createdAt,
          },
        ],
        decision,
        reasonCode,
        language,
      };
    }
  });
}

/**
 * The property's public face — name, languages, and the two catalogue strings
 * the page must show (disclosure and the route to a person). No database row
 * beyond the slug lookup, so it is safe to call before any conversation exists.
 */
export async function loadPublicProperty(
  client: pg.Client | pg.PoolClient,
  input: { slug: string; language?: string | null },
): Promise<PublicPropertyView> {
  return withGuestSession(client, input.slug, async (session) => {
    const language = normaliseLanguage(input.language, defaultLanguage(session.property));
    return propertyView(session.property, language);
  });
}

/**
 * The transcript, read under RLS from the cookie's conversation. A missing or
 * foreign ticket is an empty transcript, not a 404: the page must render for a
 * first-time visitor, and "you have no history here" is the truth.
 */
export async function loadTranscript(
  client: pg.Client | pg.PoolClient,
  input: { slug: string; language?: string | null; ticket?: GuestTicket | null },
): Promise<GuestTranscript> {
  return withGuestSession(client, input.slug, async (session, scoped) => {
    const language = normaliseLanguage(input.language, defaultLanguage(session.property));
    const property = propertyView(session.property, language);
    const ticket = input.ticket ?? null;
    if (ticket === null || ticket.propertyId !== session.context.propertyId || ticket.conversationId === null) {
      return { property, conversationId: null, messages: [] };
    }

    // Newest N, then reversed: a long thread must not return its oldest page.
    const rows = await scoped.query<MessageRow>(
      `SELECT message_id, direction, author_role, body, created_at
         FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC, message_id DESC
        LIMIT $2`,
      [ticket.conversationId, TRANSCRIPT_LIMIT],
    );
    return {
      property,
      conversationId: ticket.conversationId,
      messages: rows.rows.map(toMessage).reverse(),
    };
  });
}

/** Re-exported so the HTTP layer maps one error type to one status code. */
export { UnknownPropertyError };
