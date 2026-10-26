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
  reason: "sent" | "rejected" | "rate_limited" | "unavailable" | "timeout" | "malformed";
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
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
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
      } catch (error) {
        // An aborted fetch throws; so does a DNS failure or a reset connection.
        // Both are "we do not know whether it went", which is retryable — the
        // dedupe key in 0028 is what stops a retry that DID land from becoming a
        // second email to the same person about the same request.
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
        return { ok: true, providerId: id, retryable: false, reason: "sent" };
      }

      const detail =
        parsed !== null && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message).slice(0, 500)
          : `HTTP ${response.status}`;
      // 429 is a 4xx that is absolutely worth retrying, and treating it as
      // permanent would drop notifications precisely when the property is busiest.
      if (response.status === 429) {
        return { ok: false, providerId: null, retryable: true, reason: "rate_limited", detail };
      }
      if (response.status >= 500) {
        return { ok: false, providerId: null, retryable: true, reason: "unavailable", detail };
      }
      return { ok: false, providerId: null, retryable: false, reason: "rejected", detail };
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
  readonly sent: EmailMessage[];
  /** Set to make the next send fail, so retry behaviour is testable. */
  failWith: EmailSendResult | null;
}

export function logOnlyProvider(): LogOnlyProvider {
  const sent: EmailMessage[] = [];
  return {
    name: "log",
    sent,
    failWith: null,
    async send(message: EmailMessage): Promise<EmailSendResult> {
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
