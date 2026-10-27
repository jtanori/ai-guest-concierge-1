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
import { aiRunIdFor, answerMessage, type AnswerOutcome } from "../ai/answer.ts";
import { AiUnavailableError, type ResilientAi } from "../ai/provider.ts";
import type { Channel, EventContext } from "../events/taxonomy.ts";
import { emitEvent } from "../events/emit.ts";
import { CREATED_AT_ISO_SQL, type CreatedAtIsoRow } from "../events/clock.ts";
import {
  StaffTookOverError,
  assertModelMaySpeak,
  lockState,
  readState,
  takeover,
  transition,
} from "../conversation/state.ts";
import { captureRequest, type RequestTopic } from "../requests/capture.ts";
import { containsCardLike } from "../security/pii.ts";
import { incrementCounter } from "../metrics/counters.ts";
import { enqueueReview } from "../review/queue.ts";
import { recordOutage } from "../ai/answer.ts";
import { checkRate, type RateVerdict } from "../security/ratelimit.ts";
import { verifyBotCheck, type BotCheckConfig } from "../security/botcheck.ts";
import { loadSpend, type SpendSnapshot } from "../ai/spend.ts";
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

/**
 * S07-04 — the flood ceiling was hit. Carries the numbers the HTTP layer needs
 * to answer 429 honestly (`Retry-After`), because "slow down" without a number
 * is a puzzle, not an instruction.
 */
export class RateLimitedError extends Error {
  readonly bucket: string;
  readonly retryAfterSeconds: number;
  readonly limit: number;

  constructor(verdict: RateVerdict, message: string) {
    super(`${message} (${verdict.blocked?.bucket ?? "unknown"} limit)`);
    this.name = "RateLimitedError";
    this.bucket = verdict.blocked?.bucket ?? "unknown";
    this.retryAfterSeconds = verdict.blocked?.retryAfterSeconds ?? 60;
    this.limit = verdict.blocked?.limit ?? 0;
  }
}

/**
 * S11-03 / AC-1 — the guest's message carried something that looks like a payment
 * card number, so the turn is refused before anything is written.
 *
 * A refusal, not a sanitisation. The AC is "detected, refused in chat and never
 * logged", and the only version of "never logged" that survives a future debug
 * statement is one where the text never enters the process's data at all: it is not
 * in `messages.body`, not in an event payload, and not in the request log, because
 * nothing downstream of this throw ever sees it. The guest is told why in their own
 * language, from the catalogue, and told to send the rest without the number.
 *
 * Carries no text, deliberately: an error that quotes the offending message would
 * re-introduce the leak the class exists to prevent, and it is exactly what a
 * well-meaning `detail:` would do.
 */
export class CardNumberRefusedError extends Error {
  constructor() {
    super("message contains a payment card number; the turn was refused");
    this.name = "CardNumberRefusedError";
  }
}

/** S07-04 — the first message had no valid bot-check token. */
export class BotCheckFailedError extends Error {
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(detail === undefined ? `bot check failed: ${reason}` : `bot check failed: ${reason} (${detail})`);
    this.name = "BotCheckFailedError";
    this.reason = reason;
  }
}

/** A message long enough to be a paste of the manual is not a question. */
export const MAX_MESSAGE_CHARS = 2_000;
/** How much history a transcript read returns (newest last). */
export const TRANSCRIPT_LIMIT = 50;

export interface GuestDeps {
  /** Resilient AI (S05-01). Injected so tests own what the model says. */
  ai: ResilientAi;
  /** HMAC key for the identity cookie (`loadGuestConfig`). */
  cookieSecret: string;
  /**
   * S07-04: the bot check. Omitted means disabled — which `loadBotCheckConfig`
   * only permits in local; a staging/prod host refuses to boot without it.
   */
  botCheck?: BotCheckConfig;
  /** Injected so the tests exercise the real call shape without a network. */
  botCheckFetch?: typeof fetch;
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
  /**
   * S07-01: the origins allowed to frame this chat, straight from the
   * property's settings. The page turns it into `frame-ancestors`; an empty
   * list means only a direct visit may render it.
   */
  frameAncestors: string[];
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

/**
 * S07-02 — the answer to one tap. There is no `messages` array of a guest turn
 * and no `decision` other than `handoff`: a handoff never asks the model
 * anything, so there is nothing to answer and nothing to classify.
 */
export interface GuestHandoff {
  property: PublicPropertyView;
  conversationId: string;
  ticket: string;
  /** The acknowledgement the guest sees. Catalogue copy, never model text. */
  message: GuestMessage;
  decision: "handoff";
  reasonCode: "guest_asked_human";
  language: Lang;
  /** The request S09-05 notifies on; reused when one is already open. */
  requestId: string;
  /** False when this tap joined an existing handoff instead of starting one. */
  requestCreated: boolean;
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
    frameAncestors: [...property.frameAncestors],
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
): Promise<{ conversationId: string; created: boolean; createdAtIso: string | null }> {
  const { context } = session;
  if (ticket !== null && ticket.conversationId !== null) {
    const existing = await client.query<{ conversation_id: string }>(
      `SELECT conversation_id
         FROM conversations
        WHERE conversation_id = $1 AND identity_id = $2 AND status = 'open'`,
      [ticket.conversationId, identity.identityId],
    );
    const row = existing.rows[0];
    // No timestamp on the reuse path: `conversation_started` is emitted only for a
    // conversation this call created, so there is no event to stamp.
    if (row !== undefined) {
      return { conversationId: row.conversation_id, created: false, createdAtIso: null };
    }
  }

  const created = await client.query<{ conversation_id: string } & CreatedAtIsoRow>(
    `INSERT INTO conversations (org_id, property_id, connection_id, identity_id, language)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING conversation_id, ${CREATED_AT_ISO_SQL}`,
    [context.orgId, context.propertyId, identity.connectionId, identity.identityId, language],
  );
  return {
    conversationId: created.rows[0]!.conversation_id,
    created: true,
    createdAtIso: created.rows[0]!.created_at_iso,
  };
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
  const result = await client.query<{ message_id: string } & CreatedAtIsoRow>(
    // `clock_timestamp()`, not the column default: both messages of a turn are
    // written inside ONE transaction, and `now()` is the transaction's start
    // time, so the inbound and the outbound row would tie to the microsecond and
    // any "order by created_at" would fall back to a random UUID.
    `INSERT INTO messages
       (org_id, property_id, conversation_id, direction, author_role, body, language, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
     RETURNING message_id, ${CREATED_AT_ISO_SQL}`,
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
  // Exact text from Postgres, NOT `new Date(row.created_at).toISOString()`: a JS Date
  // holds milliseconds while clock_timestamp() wrote microseconds, so the round-trip
  // silently truncated and the event landed up to 999us before the row it describes —
  // a small copy of the very skew issue #147 exists to remove.
  return { messageId: row.message_id, createdAt: row.created_at_iso };
}

/**
 * S07-02 AC-1 — has anything been said in this conversation yet?
 *
 * Read inside the caller's transaction, under the conversation's row lock, so
 * two visitors cannot both be told they are the first. Deliberately not
 * `conversation.created`: a conversation can exist with no messages (a guest
 * tapped "talk to a person" before typing anything), and the disclosure still
 * has to be in the first thing that is said.
 */
async function isFirstReply(
  client: pg.Client | pg.PoolClient,
  conversationId: string,
): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'outbound' LIMIT 1",
    [conversationId],
  );
  return (result.rowCount ?? 0) === 0;
}

/**
 * The disclosure is prepended to the first outbound message and stored with it,
 * so the transcript a staff member reads (S08) is the text the guest read. It is
 * not re-sent on later turns: repeating it in every bubble trains guests to
 * ignore it, and the page keeps it visible in the header anyway.
 */
function withDisclosure(body: string, language: Lang, first: boolean): string {
  return first ? `${t("guest.ai_disclosure", language)}\n\n${body}` : body;
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

/**
 * S07-03 — which queue row an outcome needs, if any.
 *
 * Every branch that is not an answer ends in a promise to the guest ("I've
 * passed this to our team"), so every one of them must produce a request. The
 * mapping is exhaustive over `GuestTurn["decision"]` on purpose: a new decision
 * that forgets to declare itself here is a compile error, not a silently
 * un-captured request.
 */
export function requestTopicFor(decision: GuestTurn["decision"]): RequestTopic | null {
  switch (decision) {
    case "answer":
    case "fact":
    case "handoff":
      // `handoff` already captured its request in `postGuestHandoff` before the
      // state change; capturing again here would be a second row for one tap.
      return null;
    case "no_answer":
      return "unanswered_question";
    case "unavailable":
      return "ai_unavailable";
    case "escalate":
      return "needs_human";
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
    /** S07-04 AC-2: counters read before this turn, fed to `policyGate`. */
    spend: SpendSnapshot;
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
      {
        ai: deps.ai,
        spendTodayUsd: input.spend.todayUsd,
        conversationSpendUsd: input.spend.conversationUsd,
      },
    );
  } catch (error) {
    // `answerMessage` maps both-providers-failed to `unavailable`; this is the
    // belt-and-braces case (an adapter that throws outside the wrapper). The
    // guest still gets an honest sentence instead of a 500 — and S07-05 makes
    // this path record the outage too, because "the AI was down" must not
    // depend on which of the two catches happened to see it.
    if (error instanceof AiUnavailableError) {
      const aiRunId = await recordOutage(
        client,
        context,
        { conversationId: input.conversationId, messageId: input.messageId },
        error,
        {
          orgId: context.orgId,
          propertyId: context.propertyId,
          conversationId: input.conversationId,
          channel: input.channel,
          language: input.language,
          topic: null,
          createdAt: input.at.toISOString(),
        },
      );
      return { kind: "unavailable", detail: error.message, aiRunId };
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
  input: {
    slug: string;
    text: string;
    language?: string | null;
    ticket?: GuestTicket | null;
    /** S07-04: the client address, for the ip bucket. Null when unknown. */
    ip?: string | null;
    /** S07-04: Turnstile token from the widget, on the first message only. */
    turnstileToken?: string | null;
  },
): Promise<GuestTurn> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text === "") throw new GuestInputError("message text is required");
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new GuestInputError(`message text is longer than ${MAX_MESSAGE_CHARS} characters`);
  }
  // S11-03 AC-1. Deliberately BEFORE `withGuestSession`: the refusal must not be
  // preceded by a property lookup, an identity row or a conversation, because "we
  // refused to read the message" and "we read it, then refused to store it" are
  // different promises and only the first one is checkable.
  //
  // The counter carries no tenant labels for the same reason — resolving the slug to
  // an org is a database read, and this path does no database work. A process-wide
  // spike is still what an alert needs; per-tenant attribution would arrive with the
  // event taxonomy change recorded as S11-03-1 in the runbook.
  if (containsCardLike(text)) {
    incrementCounter("pii_blocked_total");
    throw new CardNumberRefusedError();
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

    // S06-02 took the row lock here and held it for the rest of the transaction,
    // model call included. S08-03 reversed that on purpose: holding the lock
    // across a provider call (up to the whole timeout budget) made a human's
    // "take over" wait behind the model, and the turn that started first would
    // still speak last. So this is a plain read now — a hint, not a promise —
    // and the promise is `assertModelMaySpeak` below, taken AFTER the model has
    // answered. AC-2: a writer that started before a takeover loses.
    const state = await readState(scoped, session.context, conversation.conversationId);
    // S07-02 AC-1: computed under the lock, before this turn's outbound row
    // exists, so exactly one message in a conversation can ever be the first.
    const firstReply = await isFirstReply(scoped, conversation.conversationId);

    // ---- S07-04 AC-1: is this client allowed to talk at all? --------------
    // Consumed inside this transaction, so a turn that rolls back does not
    // charge the guest's budget (see ratelimit.ts). Runs before the bot check
    // and before any database write beyond the counters, so a flood costs one
    // upsert, not a conversation.
    const rate = await checkRate(scoped, session.context, {
      ip: input.ip ?? null,
      conversationId: conversation.conversationId,
      at,
    });
    if (!rate.allowed) {
      // 429, never a 5xx and never a queue entry: a flood is not a guest
      // request, and letting it write `service_requests` rows would hand an
      // attacker a denial of service against the staff inbox (S08-01).
      throw new RateLimitedError(rate, "too many messages in this window");
    }

    // The bot check applies to the FIRST message only: Turnstile tokens are
    // single use, and a check on every turn would reject a real guest's second
    // message. `conversation.created` is the honest signal here (unlike the
    // disclosure, which needs "no outbound yet").
    if (conversation.created && deps.botCheck !== undefined) {
      const check = await verifyBotCheck(
        deps.botCheck,
        {
          token: input.turnstileToken ?? null,
          remoteIp: input.ip ?? null,
          firstMessage: true,
        },
        deps.botCheckFetch ?? fetch,
      );
      if (!check.ok) throw new BotCheckFailedError(check.reason, check.detail);
    }

    // ---- S07-04 AC-2: what has this property spent today? ----------------
    // Read from the counter table (never from memory: the cap must not multiply
    // by the number of replicas). Passed to the pipeline, which refuses to
    // generate once a cap is reached and degrades to the honest acknowledgement
    // instead — a product state, not an error.
    const spend = await loadSpend(scoped, session.context, {
      conversationId: conversation.conversationId,
      at,
    });

    // Issue #147 option 3 — no `createdAt` here on purpose. Each emit below takes the
    // timestamp of the row it describes, read back from that row's own INSERT, so the
    // business row and its event cannot straddle a reconcile window boundary. `at`
    // (the JS clock) still drives spend windows and the model call, which are not
    // reconciled against `events`; it no longer stamps anything that is.
    const eventBase: Omit<EventContext, "createdAt"> = {
      orgId: session.context.orgId,
      propertyId: session.context.propertyId,
      conversationId: conversation.conversationId,
      channel: "web",
      language,
      topic: null,
    };

    if (conversation.created && conversation.createdAtIso !== null) {
      await emitEvent(scoped, session.context, "conversation_started", {
        ...eventBase,
        createdAt: conversation.createdAtIso,
      }, {
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
    await emitEvent(scoped, session.context, "message_received", {
      ...eventBase,
      createdAt: inbound.createdAt,
    }, {
      message_id: inbound.messageId,
      characters: text.length,
    });

    // A human owns this thread: record the guest's words, answer honestly that
    // someone will reply, and do NOT call the model. This is the state S08's
    // inbox produces and S08-03 depends on.
    if (state === "awaiting_staff") {
      const pending = withDisclosure(t("guest.staff_reply_pending", language), language, firstReply);
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

    // The model call happens with NO lock held: that is the window in which a
    // human is allowed to win.
    const outcome = await askModel(deps, scoped, session.context, {
      conversationId: conversation.conversationId,
      messageId: inbound.messageId,
      text,
      language,
      channel: "web",
      at,
      spend,
    });
    const reply = replyFor(outcome, language);

    // ---- S08-03 AC-2: did a human take over while the model was thinking? ---
    // `assertModelMaySpeak` takes the conversation's row lock (the same one every
    // staff action in src/inbox/actions.ts takes) and re-reads the state, so this
    // is not a check against the snapshot read at the top of the turn. If a
    // takeover committed in the meantime, the model's answer is discarded — the
    // words were generated for a thread a human now owns, and sending them would
    // be exactly the race the AC forbids.
    try {
      await assertModelMaySpeak(scoped, session.context, conversation.conversationId);
    } catch (error) {
      if (!(error instanceof StaffTookOverError)) throw error;
      const pending = withDisclosure(t("guest.staff_reply_pending", language), language, firstReply);
      const outbound = await insertMessage(scoped, session.context, {
        conversationId: conversation.conversationId,
        direction: "outbound",
        authorRole: "ai",
        body: pending,
        language,
      });
      // The request exists so the conversation shows up in a queue: the guest
      // was told a person will reply, and a promise with no row behind it is the
      // failure S07-03 exists to prevent.
      await captureRequest(scoped, session.context, {
        conversationId: conversation.conversationId,
        topic: "needs_human",
        question: text,
        language,
        knowledgeGap: false,
        reasonCode: "staff_takeover",
        messageId: inbound.messageId,
      });
      await scoped.query(
        `UPDATE conversations SET last_activity_at = $2::timestamptz WHERE conversation_id = $1`,
        [conversation.conversationId, outbound.createdAt],
      );
      return finish("handoff", "staff_takeover", { ...outbound, body: pending });
    }

    // We hold the lock now. `resolved` reopens through `awaiting_ai` rather than
    // going straight to `idle`, because that transition is not in the matrix.
    await transition(scoped, session.context, conversation.conversationId, "awaiting_ai");

    // S07-03 AC-1: the request row is written BEFORE the message that promises
    // it, inside the same transaction. If the insert fails, the acknowledgement
    // is rolled back with it and the guest sees an error rather than a promise
    // no queue backs. The knowledge gap rides along for a no-answer — the
    // pipeline already wrote one, and `captureRequest` reuses it rather than
    // queueing the same question twice.
    const topic = requestTopicFor(reply.decision);
    if (topic !== null) {
      await captureRequest(scoped, session.context, {
        conversationId: conversation.conversationId,
        topic,
        question: text,
        language,
        knowledgeGap: reply.decision === "no_answer",
        reasonCode: reasonFor(outcome),
        // S09-05: the pointer the escalation email follows to quote the guest. The
        // text itself stays off `service_requests` — see `question` in
        // CaptureRequestInput — so what travels is the id, and the body is read at
        // send time under the tenant policy.
        messageId: inbound.messageId,
      });
    }

    const body = withDisclosure(reply.body, language, firstReply);
    const outbound = await insertMessage(scoped, session.context, {
      conversationId: conversation.conversationId,
      direction: "outbound",
      authorRole: "ai",
      body,
      language,
    });

    // S09-04 — the review work is queued HERE, in this transaction, and processed
    // only after it commits. Same commit means no window where the reply exists and
    // the review was lost, nor one where review work survives a rolled-back reply;
    // after the commit means the review machinery cannot be on the guest's path,
    // because the guest has already been answered. `enqueueReview` is one INSERT
    // that cannot raise (ON CONFLICT DO NOTHING), so it cannot roll this back.
    const reviewRunId = aiRunIdFor(outcome);
    if (reviewRunId !== null) {
      await enqueueReview(scoped, session.context, {
        aiRunId: reviewRunId,
        conversationId: conversation.conversationId,
        messageId: outbound.messageId,
      });
    }

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

    return finish(reply.decision, reasonFor(outcome), { ...outbound, body });

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
 * S07-02 — one tap, from any state.
 *
 * Why this is not `postGuestMessage(t("guest.talk_to_person"))`: a message is
 * *answered*. It reaches the classifier, which escalates, which still runs the
 * pipeline's policy and persistence steps — and on an `awaiting_staff` thread it
 * is answered with "a member of our team has this" without ever recording that
 * the guest asked for a human, and on a `resolved` thread it goes to the model.
 * The one control a guest has to reach a person must not depend on the model,
 * the provider, the guardrail or the state the thread happens to be in.
 *
 * So: lock the conversation row, take it over (state + `handoff_reasons` +
 * `human_takeover` in one transaction), open a `service_requests` row so S09-05
 * can notify even when nobody has opened the inbox, and answer with catalogue
 * copy. No provider is constructed, imported or called on this path.
 */
export async function postGuestHandoff(
  deps: GuestDeps,
  client: pg.Client | pg.PoolClient,
  input: { slug: string; language?: string | null; ticket?: GuestTicket | null },
): Promise<GuestHandoff> {
  const at = (deps.now ?? (() => new Date()))();

  return withGuestSession(client, input.slug, async (session, scoped) => {
    const language = normaliseLanguage(input.language, defaultLanguage(session.property));
    // A first-time visitor can tap the button before typing. Creating the
    // identity and the conversation here is what makes "from any state" true
    // for the state that has no conversation yet.
    const identity = await resolveIdentity(scoped, session, input.ticket ?? null, language);
    const conversation = await resolveConversation(
      scoped,
      session,
      input.ticket ?? null,
      identity,
      language,
    );
    const conversationId = conversation.conversationId;

    // Same row lock the model's writer takes (S06-02 AC-2): a turn that is
    // mid-answer either finishes first and this handoff applies to the next
    // message, or commits first and that turn stays silent. `takeover()` below
    // takes it too; taking it here first makes the read of `firstReply` part of
    // the same critical section.
    await lockState(scoped, session.context, conversationId);
    const firstReply = await isFirstReply(scoped, conversationId);

    await takeover(scoped, session.context, {
      conversationId,
      reasonCode: "guest_asked_human",
      detail: "guest_tapped_talk_to_person",
      at,
      channel: "web",
      language,
    });

    // S07-03: one implementation of "a request exists", shared with the turn
    // path below. A guest who taps twice (or taps after a page reload) has one
    // problem, so capture reuses the open request and says so in the event.
    const captured = await captureRequest(scoped, session.context, {
      conversationId,
      topic: "guest_requested_human",
      language,
      reasonCode: "guest_asked_human",
    });
    const requestId = captured.requestId;
    const requestCreated = captured.created;

    const body = withDisclosure(t("guest.staff_reply_pending", language), language, firstReply);
    const outbound = await insertMessage(scoped, session.context, {
      conversationId,
      direction: "outbound",
      // The schema's author roles are guest | ai | staff. This is a system
      // acknowledgement; `ai` is the honest label of the three (the guest is not
      // writing it and no staff member has typed it).
      authorRole: "ai",
      body,
      language,
    });
    await scoped.query(
      `UPDATE conversations SET last_activity_at = $2::timestamptz WHERE conversation_id = $1`,
      [conversationId, outbound.createdAt],
    );

    return {
      property: propertyView(session.property, language),
      conversationId,
      ticket: signGuestTicket(
        {
          identityId: identity.identityId,
          conversationId,
          propertyId: session.context.propertyId,
        },
        deps.cookieSecret,
      ),
      message: {
        messageId: outbound.messageId,
        direction: "outbound",
        authorRole: "ai",
        body,
        createdAt: outbound.createdAt,
      },
      decision: "handoff",
      reasonCode: "guest_asked_human",
      language,
      requestId,
      requestCreated,
    };
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
