/**
 * S09-05 — a request reaches a human by email.
 *
 * AC-1: every new/acknowledged request enqueues an email to the property's
 * escalation contacts.
 * AC-2: recipients come from `settings.escalation.contacts`; a property with none
 * falls back to a configured address; provider failure retries via the outbox and
 * never loses the notification.
 *
 * ## Why the row is queued inside the request's own transaction
 *
 * The alternative — a notification service that polls for recent requests — has a
 * window in which the request exists and nothing has decided to send mail yet. A
 * crash in that window is a guest who asked for a person and got silence, and it is
 * invisible: nothing records the absence. Queueing in the same transaction makes
 * "the request exists" and "somebody will be told" one atomic fact. If the email
 * can never be sent, there is still a row saying so.
 *
 * ## Why the payload is pointers and not the email
 *
 * `claim_outbox` is SECURITY DEFINER and returns `payload` across every tenant,
 * because that is the one read a worker cannot do under RLS. So anything placed in
 * the payload is visible to the claim step before tenant context exists. The guest's
 * message text does not belong there. It belongs in `messages.body`, behind the
 * tenant policy, where the worker reads it *after* setting the GUCs.
 *
 * That has a second, better consequence: recipients are resolved at **send** time,
 * not at enqueue time. A property that adds an escalation contact between the
 * request and the retry reaches that person instead of the fallback, and a settings
 * change needs no re-queueing.
 */
import pg from "pg";
import { ConfigError, type EnvName } from "../config/env.ts";
import { t, type Lang, type StringId } from "../i18n/catalog.ts";
import { parsePropertySettings, type EscalationContact } from "../settings/schema.ts";
import { writeAudit } from "../audit/write.ts";
import {
  assertSenderAddress,
  emailIdempotencyKey,
  resendProvider,
  type EmailProvider,
  type EmailSendResult,
} from "../providers/email.ts";

export type EmailStage = "new" | "acknowledged";

export const EMAIL_STAGES: readonly EmailStage[] = ["new", "acknowledged"];

export function isEmailStage(value: unknown): value is EmailStage {
  return typeof value === "string" && (EMAIL_STAGES as readonly string[]).includes(value);
}

export const EMAIL_OUTBOX_KIND = "email";

/**
 * Same ceiling as the review worker: enough attempts to ride out a provider
 * outage measured in minutes, few enough that a permanently bad address is not
 * retried for an hour. Backoff is identical for the same reason — one ladder to
 * reason about, and S11-01 will own scheduling both.
 */
export const EMAIL_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EmailConfig {
  /** The sender. Required everywhere; see `assertSenderAddress`. */
  from: string;
  /**
   * Where an escalation goes when the property configured no email contacts.
   *
   * Required outside local. AC-2 says a request must reach a human, and "every
   * property happens to have contacts configured" is not a property a deployment
   * can promise — the day someone creates a property and forgets, the fallback is
   * the only thing between a guest asking for help and nobody knowing.
   *
   * There is deliberately no hardcoded default: an address in the repository is an
   * address that receives every tenant's escalations, forever, whether or not
   * anyone still reads it.
   */
  fallbackRecipient: string | null;
  /** Absolute base of the staff console, for the link in the body. No trailing slash. */
  consoleBaseUrl: string;
  /**
   * `resend` — real delivery. `log` — local only, and the provider records what it
   * was asked to send without sending it.
   */
  provider: "resend" | "log";
  apiKey: string;
}

const ADDRESS_RE = /^[^@<>\s]+@[^@<>\s]+\.[^@<>\s]+$/;

/**
 * The same rule as `loadBotCheckConfig` and `loadGuestConfig`: local may run
 * without credentials, anything else may not. A control that is "on in production
 * if someone remembered to configure it" is off.
 */
export function loadEmailConfig(
  source: Record<string, string | undefined>,
  appEnv: EnvName = "local",
): EmailConfig {
  const from = assertSenderAddress(source["EMAIL_FROM"] ?? "");

  const apiKey = (source["EMAIL_API_KEY"] ?? "").trim();
  const fallback = (source["EMAIL_ESCALATION_FALLBACK"] ?? "").trim();

  if (appEnv === "local" && apiKey === "") {
    return {
      from,
      fallbackRecipient: fallback === "" ? null : assertAddress("EMAIL_ESCALATION_FALLBACK", fallback),
      consoleBaseUrl: consoleUrl(source, appEnv),
      provider: "log",
      apiKey: "",
    };
  }

  if (apiKey === "") {
    throw new ConfigError(
      `EMAIL_API_KEY is required when APP_ENV=${appEnv}. S09-05 AC-1: a new request ` +
        "has to reach a human even when nobody has the staff console open, and " +
        "without a provider that is a queued row nobody sends.",
    );
  }
  if (fallback === "") {
    throw new ConfigError(
      `EMAIL_ESCALATION_FALLBACK is required when APP_ENV=${appEnv}. It is where a ` +
        "request goes when the property configured no escalation contacts; there is " +
        "no default, because a default address in the repository would collect every " +
        "tenant's escalations.",
    );
  }

  return {
    from,
    fallbackRecipient: assertAddress("EMAIL_ESCALATION_FALLBACK", fallback),
    consoleBaseUrl: consoleUrl(source, appEnv),
    provider: "resend",
    apiKey,
  };
}

function consoleUrl(source: Record<string, string | undefined>, appEnv: EnvName): string {
  const raw = (source["CONSOLE_BASE_URL"] ?? "").trim();
  if (raw === "") {
    // Local only. Defaulting everywhere else would send staff a link to
    // http://localhost:3000 — which resolves, on the recipient's own machine, to
    // whatever they happen to be running there. That is worse than no link: it looks
    // like a working console link in a test send and fails for every real recipient,
    // at 3am, on the one email whose whole purpose is to be actionable.
    if (appEnv === "local") return "http://localhost:3000";
    throw new ConfigError(
      `CONSOLE_BASE_URL is required when APP_ENV=${appEnv}. It builds the link in every ` +
        "escalation email, and the local default would point recipients at their own " +
        "machine instead of the console.",
    );
  }
  // Parsed rather than string-matched: a relative or malformed base produces a
  // link that looks fine in the email and goes nowhere, which is worse than a boot
  // failure.
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`CONSOLE_BASE_URL must be an http(s) URL, got "${raw}"`);
  }
  return raw.replace(/\/+$/, "");
}

function assertAddress(name: string, value: string): string {
  if (!ADDRESS_RE.test(value)) {
    throw new ConfigError(`${name} does not look like an email address: "${value}"`);
  }
  return value;
}

export function emailProviderFromConfig(config: EmailConfig): EmailProvider {
  return config.provider === "resend"
    ? resendProvider({ apiKey: config.apiKey })
    : // Reached only in local. Not silent: the whole point of the item is that a
      // human is told, so a provider that tells nobody must say so at boot.
      {
        name: "log",
        async send(): Promise<EmailSendResult> {
          console.warn(
            "[email] EMAIL_API_KEY is not set; escalation emails are being recorded, not sent. " +
              "This is only permitted when APP_ENV=local.",
          );
          return { ok: true, providerId: null, retryable: false, reason: "sent" };
        },
      };
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export type RecipientSource = "property" | "fallback" | "none";

export interface ResolvedRecipients {
  to: readonly string[];
  source: RecipientSource;
}

/**
 * AC-2: contacts from `settings.escalation.contacts`, else the configured
 * fallback, else nobody — and "nobody" is recorded, never swallowed.
 *
 * Only `channel === 'email'` contacts count. `in_app` contacts are a different
 * delivery path (the inbox itself) and emailing an in-app handle would be sending
 * to an address that is not an address.
 */
export function resolveRecipients(
  contacts: readonly EscalationContact[],
  fallback: string | null,
): ResolvedRecipients {
  const to: string[] = [];
  const seen = new Set<string>();

  for (const contact of contacts) {
    if (contact.channel !== "email") continue;
    const value = contact.value.trim();
    // A contact whose value is not an address is a data-entry mistake in the admin
    // UI. Skipping it is right; failing the whole notification because one of three
    // contacts was mistyped is not.
    if (!ADDRESS_RE.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    to.push(value);
  }

  if (to.length > 0) return { to, source: "property" };
  if (fallback !== null && ADDRESS_RE.test(fallback)) return { to: [fallback], source: "fallback" };
  return { to: [], source: "none" };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** `{name}` interpolation. The catalogue holds the copy; this holds the facts. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? values[key]! : whole,
  );
}

/**
 * The staff-facing language.
 *
 * Not the guest's: the reader is whoever is on shift, and `conversations.language`
 * describes what the guest wrote in. `properties.languages` is the operator's own
 * declaration of what that property works in, and its first element is the primary
 * one. Anything unrecognised falls back to Spanish, which is both the catalogue
 * default and this deployment's market.
 */
export function staffLanguage(languages: readonly string[] | null): Lang {
  const first = languages?.[0];
  return first === "en" || first === "es" ? first : "es";
}

export interface ComposedEmail {
  subject: string;
  text: string;
  to: readonly string[];
  /** True when the body went to the deployment fallback rather than the property's
   * own contacts, and so omits the guest's words. */
  redacted: boolean;
}

export interface ComposeInput {
  stage: EmailStage;
  lang: Lang;
  propertyName: string;
  requestId: string;
  /** `service_requests.topic` — one of REQUEST_TOPICS, never free text. */
  topic: string;
  conversationId: string;
  /**
   * The guest's own words, when the request has any.
   *
   * Null is a real case and not an error: the "Talk to a person" button opens a
   * request with no message behind it, and the acknowledged stage announces a staff
   * action rather than a new question. Composing a body that assumed text would
   * print an empty "What the guest wrote:" block.
   */
  messageBody: string | null;
  recipients: ResolvedRecipients;
  consoleBaseUrl: string;
}

/**
 * §7 of the charter fixes the subject to the request id plus the property and
 * "no PII beyond that".
 *
 * A subject line is stored in the outbox payload's sibling columns, is indexed by
 * third-party mail infrastructure, is visible in a notification banner on a locked
 * phone, and is retained in a provider's logs. The guest's words belong in the
 * body, which goes only to people who could already open this conversation in the
 * console.
 */
export function composeRequestEmail(input: ComposeInput): ComposedEmail {
  const { stage, lang } = input;
  // The fallback address is deployment-wide, not scoped to this property, so it
  // gets the pointer and not the content.
  const redacted = input.recipients.source !== "property";
  const quote = !redacted && input.messageBody !== null && input.messageBody.trim() !== "";

  const values: Record<string, string> = {
    property: input.propertyName,
    requestId: input.requestId,
    topic: input.topic,
    conversationId: input.conversationId,
    url: `${input.consoleBaseUrl}/inbox/${input.conversationId}`,
    message: input.messageBody ?? "",
    // The acknowledging colleague's display name is not readable here: 0004's
    // `users.staff_select` policy authorises your own row only, and widening it is
    // an S02 decision, not something an email worker should quietly do. So the
    // sentence names the role, not the person — the console shows who.
    actorName: t("email.request.actor_team", lang),
  };

  const subjectId: StringId =
    stage === "new" ? "email.request.new.subject" : "email.request.acknowledged.subject";
  const introId: StringId =
    stage === "new" ? "email.request.new.intro" : "email.request.acknowledged.intro";

  // Blocks, not one template per permutation: stage x fallback x has-message is
  // eight combinations, and eight near-identical strings drift.
  // 0001 sets service_requests.conversation_id to NULL when the conversation is
  // deleted, and the request row survives. There is then no console link to give —
  // the detail page is keyed by conversation id — so the link block is dropped and
  // the body says why. Printing `${base}/inbox/` instead would send a link that
  // renders as a real URL, resolves to the inbox index or a 404, and looks like a
  // bug in the console rather than a deleted conversation.
  const hasConversation = input.conversationId.trim() !== "";

  const blocks = [
    fill(t(introId, lang), values),
    fill(t("email.request.facts", lang), values),
    fill(t(hasConversation ? "email.request.conversation" : "email.request.no_conversation", lang), values),
    ...(quote
      ? [fill(t("email.request.quote", lang), values)]
      : redacted
        ? [fill(t("email.request.redacted_notice", lang), values)]
        : []),
    ...(hasConversation ? [fill(t("email.request.open", lang), values)] : []),
  ];

  return {
    subject: fill(t(subjectId, lang), values),
    text: blocks.join("\n\n"),
    to: input.recipients.to,
    redacted,
  };
}

// ---------------------------------------------------------------------------
// Enqueue — inside the request's transaction
// ---------------------------------------------------------------------------

export interface EnqueueEmailInput {
  orgId: string;
  propertyId: string;
  requestId: string;
  conversationId: string;
  /** The guest message that triggered the request, when there is one. */
  messageId: string | null;
  stage: EmailStage;
  /** The human whose action is being announced. Null for the guest-created stage. */
  actorUserId?: string | null;
}

export interface EnqueueEmailResult {
  queued: boolean;
  /** False when a row for this request+stage was already in flight. */
  deduped: boolean;
  outboxId: bigint | null;
}

/**
 * One queued email per (request, stage).
 *
 * `new` and `acknowledged` are two notifications, so the key carries the stage —
 * keying on the request alone would silently swallow the acknowledgement, which is
 * the more actionable of the two. Within a stage, 0028's partial unique index makes
 * a double submission from a phone on a bad connection produce one email rather
 * than three.
 *
 * Never throws on a duplicate: `queued: false` is a normal outcome, and an
 * escalation that raises would take the guest's request down with it.
 */
export async function enqueueEmail(
  client: pg.Client,
  input: EnqueueEmailInput,
): Promise<EnqueueEmailResult> {
  if (!isEmailStage(input.stage)) {
    throw new Error(`unknown email stage "${String(input.stage)}"`);
  }

  const dedupeKey = `${input.requestId}:${input.stage}`;

  const inserted = await client.query<{ outbox_id: string; inserted: boolean }>(
    `INSERT INTO outbox
       (org_id, property_id, kind, status, payload, attempts, next_attempt_at)
     VALUES
       ($1, $2, 'email', 'pending',
        -- Cast every value: jsonb_build_object is variadic "any", so Postgres
        -- cannot infer a parameter's type from it and the statement fails to plan
        -- ("could not determine data type of parameter $3"). The cast also pins
        -- message_id as a real uuid-or-null rather than a string that happens to
        -- look like one.
        jsonb_build_object(
          -- Pointers, not content: this payload crosses every tenant on its way
          -- out of the definer claim function.
          'dedupe_key', $3::text,
          'request_id', $4::uuid,
          'conversation_id', $5::uuid,
          'message_id', $6::uuid,
          'stage', $7::text
        ),
        0, now())
     ON CONFLICT (property_id, kind, ((payload ->> 'dedupe_key')))
       WHERE kind = 'email' AND status IN ('pending', 'sending', 'failed')
       DO NOTHING
     RETURNING outbox_id, (xmax = 0) AS inserted`,
    [
      input.orgId,
      input.propertyId,
      dedupeKey,
      input.requestId,
      input.conversationId,
      input.messageId,
      input.stage,
    ],
  );

  // ON CONFLICT DO NOTHING returns zero rows when it did nothing, so there is no
  // id to report and nothing to audit — the first enqueue already wrote that row.
  if (inserted.rowCount === 0) {
    return { queued: false, deduped: true, outboxId: null };
  }

  const outboxId = BigInt(inserted.rows[0]!.outbox_id);

  // Audited because it is the evidence for AC-1 that survives the outbox row being
  // marked sent: "a human was asked for, at this moment, for this request". The
  // detail carries counts and not addresses — recipient emails are PII, and the
  // outbox row is where delivery state lives.
  await writeAudit(client, {
    orgId: input.orgId,
    propertyId: input.propertyId,
    actorUserId: input.actorUserId ?? null,
    action: "notification.queued",
    entityType: "request",
    entityId: input.requestId,
    detail: {
      stage: input.stage,
      outboxId: outboxId.toString(),
      kind: EMAIL_OUTBOX_KIND,
    },
  });

  return { queued: true, deduped: false, outboxId };
}

// ---------------------------------------------------------------------------
// The send loop
// ---------------------------------------------------------------------------

export interface ClaimedEmailRow {
  claimed_id: string;
  claimed_org: string;
  claimed_property: string;
  claimed_payload: Record<string, unknown>;
  claimed_attempts: number;
}

/** The facts the worker loads under tenant RLS, after the claim. */
interface RequestFacts {
  propertyName: string;
  languages: string[] | null;
  settings: unknown;
  topic: string | null;
  conversationId: string | null;
  messageBody: string | null;
}

export interface EmailOutboxResult {
  processed: number;
  sent: number;
  retried: number;
  dead: number;
  /** Queued but nobody to send to. Distinct from `dead`: this is a configuration
   * gap, not a provider failure, and it is the one an operator can fix. */
  noRecipient: number;
}

/** Same ladder as the review worker — 1s, 2s, 4s, 8s, 16s, capped at a minute. */
export function emailBackoffMs(attempt: number): number {
  const exp = Math.min(Math.max(attempt, 0), 10);
  return Math.min(1000 * 2 ** exp, 60_000);
}

/**
 * AC-2's second half: the provider may fail and the notification is still not lost.
 *
 * Three outcomes, and only one of them is a retry:
 *
 * - **sent** — the row becomes `sent` with the provider's own id, which is the
 *   delivery evidence that is not ours to invent.
 * - **retryable failure** — `failed`, attempts incremented, `next_attempt_at`
 *   pushed out. The row still exists; a provider down for an hour produces a queue,
 *   not a silence.
 * - **permanent refusal** — straight to `dead`. Retrying a rejected address five
 *   times produces five identical refusals and a `dead` row that looks exactly like
 *   an outage, which sends the operator looking in the wrong place.
 *
 * No-recipients is a fourth case and is deliberately not a retry either: nothing
 * about the property's settings will change between attempt one and attempt two, so
 * the row goes `dead` with reason `no_recipient` and an audit entry naming it.
 * Silent success here would be the worst outcome in the file — the guest asked for a
 * person, and the system would be recording that it handled it.
 */
export async function processEmailOutbox(
  pool: pg.Pool,
  provider: EmailProvider,
  config: EmailConfig,
  maxRows = 50,
): Promise<EmailOutboxResult> {
  const result: EmailOutboxResult = { processed: 0, sent: 0, retried: 0, dead: 0, noRecipient: 0 };

  for (let i = 0; i < maxRows; i += 1) {
    const client = await pool.connect();
    try {
      const outcome = await processOneEmail(client, provider, config);
      // Nothing due: stop rather than spin. A queue that is empty stays empty until
      // somebody enqueues, and burning connections to re-check is how a worker
      // starves the pool it shares with the API.
      if (outcome === null) break;
      result.processed += 1;
      if (outcome === "noRecipient") {
        // Counted in both: it IS a dead row, and it is also the one dead-row cause an
        // operator can fix by editing settings rather than by waiting out an outage.
        result.noRecipient += 1;
        result.dead += 1;
      } else {
        result[outcome] += 1;
      }
    } finally {
      client.release();
    }
  }

  return result;
}

type EmailOutcome = "sent" | "retried" | "dead" | "noRecipient";

/**
 * One row, one transaction.
 *
 * The BEGIN is not ceremony. `claim_outbox` ends in `FOR UPDATE SKIP LOCKED`, and
 * that lock lives exactly as long as the transaction that took it — so without an
 * explicit BEGIN each statement is its own transaction, the lock is released the
 * instant the claim returns, and two workers can claim the same row and both send
 * it. COMMIT with no open transaction succeeds with a warning, so this failure is
 * invisible in a single-worker test and shows up in production as duplicate
 * escalation emails.
 */
async function processOneEmail(
  client: pg.PoolClient,
  provider: EmailProvider,
  config: EmailConfig,
): Promise<EmailOutcome | null> {
  let claimed: ClaimedEmailRow | null = null;
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");

    // The one cross-tenant read, through the definer function 0028 generalised to
    // every kind. `outbox` is FORCE RLS, so without it a worker sees no rows at all
    // — which looks exactly like a healthy empty queue.
    const rows = await client.query<ClaimedEmailRow>(
      "SELECT * FROM claim_outbox($1, 1)",
      [EMAIL_OUTBOX_KIND],
    );
    if (rows.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    claimed = rows.rows[0]!;

    // From here the row's own tenant is the context and the work runs as
    // concierge_app under ordinary RLS: the definer window was only the claim.
    // Transaction-local (`true`), so a rollback takes the context with it and a
    // pooled connection cannot carry one tenant's GUCs into the next row.
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [claimed.claimed_org]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [
      claimed.claimed_property,
    ]);

    const outboxId = BigInt(claimed.claimed_id);
    const attempts = claimed.claimed_attempts + 1;
    const outcome = await sendOne(client, provider, config, claimed);

    if (outcome.kind === "sent") {
      await client.query(
        `UPDATE outbox
            SET status = 'sent', attempts = $2, last_error = NULL,
                processed_at = now(), next_attempt_at = NULL
          WHERE outbox_id = $1`,
        [outboxId, attempts],
      );
      await audit(client, claimed, "notification.sent", {
        stage: outcome.stage,
        // The provider's own id, which is the delivery evidence that is not ours to
        // invent. Recipients are counted, not listed: an address is PII and the
        // outbox row is where delivery state lives.
        providerId: outcome.providerId,
        recipientSource: outcome.recipientSource,
        recipientCount: outcome.recipientCount,
        redacted: outcome.redacted,
      });
      await client.query("COMMIT");
      return "sent";
    }

    if (outcome.kind === "no_recipient") {
      // Not a retry: nothing about the property's settings changes between attempt
      // one and attempt two. Dead, named, and audited — silently succeeding here
      // would record that a waiting guest had been handled.
      await markDead(client, outboxId, attempts, "no_recipient: no escalation contact and no fallback");
      await audit(client, claimed, "notification.dead", {
        stage: outcome.stage,
        reason: "no_recipient",
      });
      await client.query("COMMIT");
      return "noRecipient";
    }

    if (outcome.retryable && attempts < EMAIL_MAX_ATTEMPTS) {
      const backoffSeconds = emailBackoffMs(attempts) / 1000;
      await client.query(
        `UPDATE outbox
            SET status = 'failed', attempts = $2, last_error = $3,
                processed_at = now(),
                next_attempt_at = now() + make_interval(secs => $4)
          WHERE outbox_id = $1`,
        [outboxId, attempts, outcome.error.slice(0, 500), backoffSeconds],
      );
      await client.query("COMMIT");
      return "retried";
    }

    // Permanent refusal, or the retries are gone. Straight to dead: five identical
    // refusals of a rejected address produce a dead row that looks exactly like an
    // outage and sends the operator looking in the wrong place.
    await markDead(client, outboxId, attempts, outcome.error);
    await audit(client, claimed, "notification.dead", {
      stage: outcome.stage,
      reason: outcome.reason,
      attempts,
    });
    await client.query("COMMIT");
    return "dead";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Bookkeeping in its OWN transaction: the one above was rolled back, so
    // recording the attempt inside it would have recorded nothing. One poison row
    // must not stop the rest of the queue either, so this never throws.
    return recordEmailFailure(client, claimed, error);
  }
}

/**
 * Records an attempt that failed for our reason, not the provider's — a database
 * error, a settings row that will not parse, a broken connection.
 *
 * Never throws: a worker that dies while reporting a death is a worker that leaves
 * no trace, and the row it was holding stays `pending` forever with nothing saying
 * why.
 */
async function recordEmailFailure(
  client: pg.PoolClient,
  claimed: ClaimedEmailRow | null,
  error: unknown,
): Promise<EmailOutcome> {
  if (claimed === null) {
    // The claim itself failed, so there is no row to book-keep against. It is
    // untouched and still pending, which is the correct state; the caller's loop
    // stops on the next pass.
    return "dead";
  }
  const attempts = claimed.claimed_attempts + 1;
  const dead = attempts >= EMAIL_MAX_ATTEMPTS;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE concierge_app");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [claimed.claimed_org]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [
      claimed.claimed_property,
    ]);
    await client.query(
      `UPDATE outbox
          SET attempts = $2,
              status = $3,
              processed_at = now(),
              -- A dead row gets NO due-time. next_attempt_at means "next eligible
              -- for claiming", so leaving a timestamp on a row that will never be
              -- claimed again reads as a missed retry, which sends whoever is
              -- debugging in the wrong direction. processed_at is the column that
              -- answers "when did we give up".
              --
              -- This is a deliberate difference from the review worker's
              -- recordFailure, which stamps a due-time on dead rows because it
              -- writes no processed_at and needs *some* give-up timestamp. Both
              -- email paths here set processed_at, so they agree with each other.
              next_attempt_at = CASE WHEN $3 = 'dead'
                                     THEN NULL
                                     ELSE now() + make_interval(secs => $4) END,
              last_error = left($5, 500)
        WHERE outbox_id = $1`,
      [claimed.claimed_id, attempts, dead ? "dead" : "failed", emailBackoffMs(attempts) / 1000, message],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
  }
  return dead ? "dead" : "retried";
}

async function markDead(
  client: pg.Client,
  outboxId: bigint,
  attempts: number,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE outbox
        SET status = 'dead', attempts = $2, last_error = $3,
            processed_at = now(), next_attempt_at = NULL
      WHERE outbox_id = $1`,
    [outboxId, attempts, error.slice(0, 500)],
  );
}

async function audit(
  client: pg.Client,
  row: ClaimedEmailRow,
  action: "notification.sent" | "notification.dead",
  detail: Record<string, unknown>,
): Promise<void> {
  await writeAudit(client, {
    orgId: row.claimed_org,
    propertyId: row.claimed_property,
    // No actor: this is the worker. `audit_log.actor_user_id` is nullable and a
    // system action attributed to a person would be a false record.
    actorUserId: null,
    action,
    entityType: "request",
    entityId: String(row.claimed_payload["request_id"] ?? ""),
    detail,
  });
}

type SendOutcome =
  | {
      kind: "sent";
      stage: string;
      providerId: string | null;
      recipientSource: RecipientSource;
      recipientCount: number;
      redacted: boolean;
    }
  | { kind: "no_recipient"; stage: string }
  | { kind: "failed"; stage: string; retryable: boolean; reason: string; error: string };

async function sendOne(
  client: pg.Client,
  provider: EmailProvider,
  config: EmailConfig,
  row: ClaimedEmailRow,
): Promise<SendOutcome> {
  const payload = row.claimed_payload;
  const stage: EmailStage = isEmailStage(payload["stage"]) ? payload["stage"] : "new";
  const requestId = String(payload["request_id"] ?? "");
  const messageId = payload["message_id"] === null ? null : String(payload["message_id"] ?? "");

  // Re-read under RLS rather than trusting the payload: the payload is a pointer,
  // and the facts (property name, contacts, the guest's words) live behind the
  // tenant policy where they are also current.
  // `service_requests` carries `topic`, not a request type, and has no message
  // column: the pointer to the triggering message travels in the payload, and the
  // body is read here under the tenant policy. The LEFT JOIN is what makes the
  // button-tap request (no message) and a since-deleted message both compose.
  const facts = await client.query<RequestFacts>(
    `SELECT p.name             AS "propertyName",
            p.languages        AS "languages",
            p.settings         AS "settings",
            sr.topic           AS "topic",
            sr.conversation_id AS "conversationId",
            m.body             AS "messageBody"
       FROM service_requests sr
       JOIN properties p
         ON p.org_id = sr.org_id AND p.property_id = sr.property_id
       LEFT JOIN messages m
         ON m.org_id = sr.org_id
        AND m.property_id = sr.property_id
        AND m.message_id = $4
      WHERE sr.org_id = $1 AND sr.property_id = $2 AND sr.request_id = $3`,
    [row.claimed_org, row.claimed_property, requestId, messageId],
  );

  if (facts.rowCount === 0) {
    // The request is gone (retention, or a bad payload). Nothing to announce and
    // nothing will make it reappear, so this is not retryable.
    return {
      kind: "failed",
      stage,
      retryable: false,
      reason: "request_missing",
      error: `service_request ${requestId} is not readable in this tenant`,
    };
  }

  const fact = facts.rows[0]!;
  const settings = parsePropertySettings(fact.settings);
  const recipients = resolveRecipients(settings.escalation.contacts, config.fallbackRecipient);

  if (recipients.to.length === 0) {
    return { kind: "no_recipient", stage };
  }

  // A request whose conversation has been detached (0001 sets conversation_id to
  // NULL on conversation delete) still deserves an email: the facts block still names
  // the request and the property. The empty string is the signal the composer reads
  // to drop the console-link block, so no link to nowhere is ever printed.
  const conversationId = fact.conversationId === null ? "" : String(fact.conversationId);

  const composed = composeRequestEmail({
    stage,
    lang: staffLanguage(fact.languages),
    propertyName: fact.propertyName,
    requestId,
    topic: fact.topic ?? "needs_human",
    conversationId,
    // The payload named the message; the row supplied its body. Null when the
    // request has none (button tap) or the message is gone, and the composer then
    // drops the quote block rather than printing an empty one.
    messageBody: fact.messageBody,
    recipients,
    consoleBaseUrl: config.consoleBaseUrl,
  });

  const sent: EmailSendResult = await provider.send({
    to: composed.to,
    subject: composed.subject,
    text: composed.text,
    from: config.from,
    // Replies go to the sender, which is the property's own desk address. Not the
    // guest: a reply-to pointing at a guest would open a channel that no message
    // row records, and every guest-visible word is supposed to be one.
    replyTo: config.from,
    // Keyed on THIS ROW, so every retry of it carries the same key and the provider
    // replays the original response instead of delivering a second email. This is
    // the only thing that makes the retry path safe: 0028's dedupe index stops a
    // second outbox ROW for one request+stage, and does nothing about a second
    // delivery of the row that already exists when Resend accepted the first attempt
    // and we lost the response.
    idempotencyKey: emailIdempotencyKey(row.claimed_id),
  });

  if (sent.ok) {
    return {
      kind: "sent",
      stage,
      providerId: sent.providerId,
      recipientSource: recipients.source,
      recipientCount: composed.to.length,
      redacted: composed.redacted,
    };
  }

  return {
    kind: "failed",
    stage,
    retryable: sent.retryable,
    reason: sent.reason,
    error: `${sent.reason}${sent.detail === undefined ? "" : `: ${sent.detail}`}`,
  };
}
