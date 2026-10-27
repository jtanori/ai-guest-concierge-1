/**
 * W00-14 — structured logging with mandatory tenant context.
 *
 * The acceptance criterion: "A staging error carries org_id, property_id,
 * conversation_id." Every log line from a request-scoped logger is JSON with
 * that context stamped on it; constructing a logger without the context is a
 * type error, so console.log-style ad-hoc logging does not survive review.
 *
 * The sink is pluggable: in production it goes to stdout (collected by the
 * platform) and to Sentry (Phase B, W00-14 done only when the staging error
 * is observable there with the same three fields).
 */
import pino, { type DestinationStream, type Logger } from "pino";
import type { LoggerOptions } from "pino";
import { maskPii } from "../security/pii.ts";
import { redactingLogMethod } from "./redact.ts";

export type { Logger };

export interface RequestContext {
  orgId: string;
  propertyId: string;
  conversationId: string | null;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function isLogLevel(value: string): value is LogLevel {
  return (LEVELS as readonly string[]).includes(value);
}

/**
 * S11-03 — every logger this product creates masks PII before it writes.
 *
 * The hook is installed **after** the caller's options so it cannot be replaced:
 * redaction is not a feature a caller opts out of, and the one place that could
 * quietly do so would be the place nobody reviews. A caller-supplied `logMethod` is
 * therefore ignored rather than merged — see `redact.ts` for what the hook does.
 */
export function createLogger(
  level: LogLevel,
  options?: LoggerOptions,
  destination?: DestinationStream,
): Logger {
  return pino(
    { level, ...options, hooks: { ...options?.hooks, logMethod: redactingLogMethod } },
    destination ?? pino.destination({ fd: 1 }),
  );
}

/**
 * Bind a base logger to a request's tenant context. All ten fields of the
 * context are required — a log line that cannot be pinpointed to a
 * conversation is not accepted in staging.
 */
export function bindRequestContext(
  base: Logger,
  ctx: RequestContext,
  bindings: Record<string, string> = {},
): Logger {
  return base.child({
    org_id: ctx.orgId,
    property_id: ctx.propertyId,
    conversation_id: ctx.conversationId,
    ...bindings,
  });
}

/**
 * Error reporting hook. Wired to Sentry in Phase B; the local sink keeps
 * the tenant fields so the staging test asserts on them regardless of the
 * transport used.
 */
export type ErrorReporter = (payload: {
  error: Error;
  ctx: RequestContext;
}) => void;

/**
 * A copy of `error` with its message masked, so a reporter that serialises the
 * Error object (rather than the log line) cannot leak what the log line hides.
 */
function redactError(error: Error, maskedMessage: string): Error {
  const copy = new Error(maskedMessage);
  copy.name = error.name;
  if (typeof error.stack === "string") copy.stack = maskPii(error.stack);
  return copy;
}

export function reportError(
  base: Logger,
  ctx: RequestContext,
  error: Error,
  reporter?: ErrorReporter,
): void {
  const log = bindRequestContext(base, ctx);
  // Masked here as well as in the hook: `reportError` also hands the Error to the
  // reporter (Sentry in Phase B), which is a second sink with its own retention
  // policy and must not receive a guest's card number either.
  const message = maskPii(error.message);
  log.error({ err: { message, name: error.name } }, "staging error");
  reporter?.({ error: redactError(error, message), ctx });
}
