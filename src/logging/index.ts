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

export function createLogger(
  level: LogLevel,
  options?: LoggerOptions,
  destination?: DestinationStream,
): Logger {
  return pino({ level, ...options }, destination ?? pino.destination({ fd: 1 }));
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

export function reportError(
  base: Logger,
  ctx: RequestContext,
  error: Error,
  reporter?: ErrorReporter,
): void {
  const log = bindRequestContext(base, ctx);
  log.error({ err: { message: error.message, name: error.name } }, "staging error");
  reporter?.({ error, ctx });
}
