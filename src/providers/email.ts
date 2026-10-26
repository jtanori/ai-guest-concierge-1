/**
 * S09-05 — the email provider adapter.
 *
 * Plain `fetch` and no SDK, on purpose: the standing rule is no new runtime
 * dependency without explicit approval, and a transactional-email API is one POST
 * with a bearer token. An SDK here would be a supply-chain surface for something
 * this file does in forty lines.
 *
 * ## The interface is the deliverable
 *
 * `EmailProvider` is what the rest of the system depends on; `resendProvider` is
 * one implementation of it. That matters for the two things this item cannot yet
 * prove: the credentials are not available (DEC-4 closed on the provider, not on a
 * key), and §7's "real delivered email" evidence is outstanding. Every layer above
 * this one is testable against `logOnlyProvider` or a fake, so the only untested
 * code is the HTTP call itself — one function, one shape, verified against
 * Resend's published contract rather than against a live account.
 */
import { ConfigError } from "../config/env.ts";

export interface EmailMessage {
  to: readonly string[];
  subject: string;
  /** Plain text. The escalation email is read on a phone by a person who is not
   * the recipient's marketing department; a text part is enough and cannot render
   * wrong. */
  text: string;
  from: string;
  /** Where a reply should go. For a request notification that is the staff inbox,
   * not the guest — replying to the sender must not become a channel to the guest
   * that nothing logs. */
  replyTo?: string | null;
  /**
   * Provider-side idempotency key, sent as Resend's `Idempotency-Key` header.
   *
   * This is what makes a retry safe, and nothing else in the system does. The
   * database dedupe index in 0028 stops a second *outbox row* for the same
   * request+stage; it does nothing about a second *delivery* of the row that
   * already exists. If Resend accepts the email and the response is lost — a stalled
   * body, a reset connection, a process killed before the `sent` commit — the row is
   * still claimable and the next attempt would deliver a second copy. With the same
   * key and the same payload Resend replays the original response instead.
   *
   * The key must therefore be stable across retries of one row and distinct between
   * rows: `emailIdempotencyKey(outboxId)`. Deriving it from anything regenerated per
   * attempt (a fresh UUID) builds idempotency that is idempotent against nothing, and
   * deriving it from the dedupe key would suppress an operator's deliberate re-queue
   * of a dead row for Resend's whole 24-hour window.
   */
  idempotencyKey?: string | null;
}

export interface EmailSendResult {
  ok: boolean;
  /** The provider's own message id, when it gave one. Stored on the outbox row so
   * "did this actually leave?" has an answer that is not ours. */
  providerId: string | null;
  /**
   * Whether retrying could possibly help.
   *
   * A 4xx means the provider understood the request and refused it — a rejected
   * address, an unverified sender domain, a missing key. Retrying that five times
   * produces five identical refusals and a `dead` row that looks like an outage.
   * A 5xx, a 429 or a network failure is worth another attempt.
   */
  retryable: boolean;
  /** Machine-readable cause. Never contains the API key. */
  reason:
    | "sent"
    | "rejected"
    | "rate_limited"
    | "unavailable"
    | "timeout"
    | "malformed"
    /** A retry of the same key is still in flight at the provider; back off and try again. */
    | "conflict_in_flight"
    /** The key was already used with a different payload; a human should look. */
    | "conflict_payload";
  /** The provider's own words, truncated. Deliberately excludes recipient
   * addresses: `outbox.last_error` is readable by anyone who can read the tenant's
   * rows, and an address in an error string is PII in a place nobody expects it. */
  detail?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export const EMAIL_TIMEOUT_MS = 10_000;
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendConfig {
  apiKey: string;
  timeoutMs?: number;
  /** Injected so the tests exercise the real call shape without a network. */
  fetch?: typeof fetch;
  endpoint?: string;
}

/**
 * Resend's `Idempotency-Key`, derived from the outbox row that is being sent.
 *
 * Stable across every retry of that row (so a lost response cannot become a second
 * email) and unique per row (so an operator re-queueing a `dead` row is a real send
 * rather than a suppressed one). Resend keeps keys for 24 hours; this worker's whole
 * retry ladder is about fifteen seconds, so the key cannot expire mid-retry.
 */
export function emailIdempotencyKey(outboxId: bigint | string): string {
  return `concierge-email/${outboxId.toString()}`;
}

export function resendProvider(config: ResendConfig): EmailProvider {
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? EMAIL_TIMEOUT_MS;
  const endpoint = config.endpoint ?? RESEND_ENDPOINT;

  return {
    name: "resend",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      if (message.to.length === 0) {
        // Not a provider failure and not retryable: there is nobody to send to, and
        // the caller has already decided that is worth recording.
        return { ok: false, providerId: null, retryable: false, reason: "rejected", detail: "no recipients" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // The timeout has to cover reading the BODY, not just receiving the headers.
      //
      // `fetch` resolves as soon as the response headers arrive; the body is a
      // separate stream. Clearing the timer at that point — the obvious reading of
      // "time out the request" — leaves `response.text()` with no deadline at all, so
      // a provider that sends headers and then stalls the body hangs this function
      // forever. That is not a slow email: the caller is holding a database
      // transaction and a `FOR UPDATE` row lock while it waits, so one stalled body
      // pins an outbox row no other worker can claim.
      //
      // Everything through the body read therefore shares one try/finally, and an
      // abort mid-body is reported as a timeout rather than as a success.
      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
            ...(message.idempotencyKey === undefined || message.idempotencyKey === null ||
            message.idempotencyKey === ""
              ? {}
              : { "idempotency-key": message.idempotencyKey }),
          },
          body: JSON.stringify({
            from: message.from,
            to: [...message.to],
            subject: message.subject,
            text: message.text,
            ...(message.replyTo === undefined || message.replyTo === null
              ? {}
              : { reply_to: message.replyTo }),
          }),
          signal: controller.signal,
        });

        const raw = await response.text();
        let parsed: unknown = null;
        try {
          parsed = raw === "" ? null : (JSON.parse(raw) as unknown);
        } catch {
          parsed = null;
        }

        if (response.ok) {
          const id =
            parsed !== null && typeof parsed === "object" && "id" in parsed
              ? String((parsed as { id: unknown }).id)
              : null;
          // A replayed idempotent response is a success and carries the ORIGINAL
          // email id, which is exactly the evidence wanted: the retry proves the
          // first attempt landed without delivering a second email.
          return { ok: true, providerId: id, retryable: false, reason: "sent" };
        }

        const record =
          parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
        const detail =
          record !== null && "message" in record
            ? String(record["message"]).slice(0, 500)
            : `HTTP ${response.status}`;
        const code = record !== null && "name" in record ? String(record["name"]) : "";

        // 409 concurrent_idempotent_requests: an attempt with this key is still in
        // flight, so Resend cannot replay its answer yet. Retryable — backing off is
        // precisely what it asks for, and the next attempt gets the original response.
        if (response.status === 409 && code === "concurrent_idempotent_requests") {
          return { ok: false, providerId: null, retryable: true, reason: "conflict_in_flight", detail };
        }
        // 409 invalid_idempotent_request: this key was already used with a DIFFERENT
        // payload, so an earlier attempt was accepted and its email is not the one we
        // would send now. Not retryable — the same key and payload would 409 forever —
        // and not reported as sent, because we cannot prove which content went out.
        // It reaches the operator as a dead row with its own reason, which is the
        // honest outcome: rare (it needs the property name, contacts or message to
        // change between attempts) and worth a human looking at the provider log.
        if (response.status === 409 && code === "invalid_idempotent_request") {
          return { ok: false, providerId: null, retryable: false, reason: "conflict_payload", detail };
        }
        // 429 is a 4xx that is absolutely worth retrying, and treating it as
        // permanent would drop notifications precisely when the property is busiest.
        if (response.status === 429) {
          return { ok: false, providerId: null, retryable: true, reason: "rate_limited", detail };
        }
        if (response.status >= 500) {
          return { ok: false, providerId: null, retryable: true, reason: "unavailable", detail };
        }
        return { ok: false, providerId: null, retryable: false, reason: "rejected", detail };
      } catch (error) {
        // An aborted fetch throws, whether the abort landed on the connection or on
        // the body stream; so does a DNS failure or a reset connection. All of them
        // mean "we do not know whether it went", which is retryable — and safe to
        // retry only because the idempotency key above makes the provider deduplicate
        // it. Without that key this branch is how a guest gets the same escalation
        // email twice.
        const timedOut = error instanceof Error && error.name === "AbortError";
        return {
          ok: false,
          providerId: null,
          retryable: true,
          reason: timedOut ? "timeout" : "unavailable",
          detail: timedOut ? `timed out after ${timeoutMs}ms` : "provider unreachable",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The local/test provider: it records what it was asked to send and sends nothing.
 *
 * Not a stub that silently succeeds — `sent` is collected so a test can assert on
 * the recipients and the body, which is how "the fallback was used" and "the guest
 * never appears in the subject" get proven without an inbox.
 */
export interface LogOnlyProvider extends EmailProvider {
  /** Everything successfully "sent". */
  readonly sent: EmailMessage[];
  /**
   * Every message handed to `send`, failures included.
   *
   * `sent` alone cannot prove the property that matters most about retries: that
   * attempt 1 (which failed) and attempt 2 (which succeeded) carried the SAME
   * idempotency key. A failed attempt records nothing in `sent`, so without this the
   * first key is simply unobservable and the assertion is untestable.
   */
  readonly attempts: EmailMessage[];
  /** Set to make the next send fail, so retry behaviour is testable. */
  failWith: EmailSendResult | null;
}

export function logOnlyProvider(): LogOnlyProvider {
  const sent: EmailMessage[] = [];
  const attempts: EmailMessage[] = [];
  return {
    name: "log",
    sent,
    attempts,
    failWith: null,
    async send(message: EmailMessage): Promise<EmailSendResult> {
      attempts.push(message);
      if (this.failWith !== null) return this.failWith;
      sent.push(message);
      return { ok: true, providerId: `log-${sent.length}`, retryable: false, reason: "sent" };
    },
  };
}

/**
 * `EMAIL_FROM` is required and has no default.
 *
 * A default sender address would be a published one: every deployment that forgot
 * to configure it would send escalation mail from the same domain, which is how a
 * domain gets a reputation it did not earn and how one property's notifications
 * start landing in another's spam folder. The failure is at boot, where it can be
 * fixed, rather than on the first escalation, where it cannot — the same rule
 * `loadBotCheckConfig` and `loadGuestConfig` apply.
 */
export function assertSenderAddress(value: string): string {
  const from = value.trim();
  if (from === "") throw new ConfigError("EMAIL_FROM is required and must not be empty");
  // One address, optionally with a display name: `Hotel Casa Mesa <desk@casa.mx>`.
  // Validated loosely on purpose — the provider is the authority on deliverability,
  // and a strict local regex rejects addresses that work.
  if (!/<[^@>\s]+@[^@>\s]+>/.test(from) && !/^[^@<>\s]+@[^@<>\s]+$/.test(from)) {
    throw new ConfigError(`EMAIL_FROM does not look like an address: "${from}"`);
  }
  return from;
}
