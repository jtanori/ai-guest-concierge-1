/**
 * S11-03 / AC-1 — "never logged", enforced at the writer rather than asked of callers.
 *
 * A redactor that has to be remembered at every call site is a redactor that will be
 * forgotten at the call site that matters. This module installs one hook in
 * `createLogger` and one transformation in `reportError`, so **every** line that
 * leaves the process has already been through `maskPii` — including lines written by
 * code that has never heard of this file.
 *
 * ## Why a hook and not `redact: [...]`
 *
 * pino's built-in `redact` masks *paths* (`req.headers.authorization`). The charter's
 * requirement is the opposite shape: mask any **string value**, wherever it sits,
 * including `body`, `question`, `answer`, `payload` and `detail` — keys nobody can
 * enumerate in advance because the next feature adds one. So the hook walks the
 * object.
 *
 * ## What it deliberately does not do
 *
 * Numbers, booleans, null and dates pass through untouched: a counter value is not
 * PII, and stringifying it would break every log query that parses it. Only strings
 * are inspected, and only strings are replaced.
 *
 * Errors are special-cased. `err.message` is where a driver puts the failing query,
 * which can contain a bound guest message — so it is masked like any other string,
 * while `name` and `stack` (code, not data) are kept.
 */
import type { Logger, LogFn } from "pino";
import { maskPii } from "../security/pii.ts";

const MAX_DEPTH = 8;

/**
 * Deep-copy `value`, masking every string it contains.
 *
 * Depth-limited because a log call is handed objects of unknown shape (a parsed
 * request body, a database error, a circular reference in a library's error). At the
 * limit the value is replaced by a marker rather than followed: an unbounded walk
 * here would be a way to crash the logger — and a crash in the logger takes the
 * request with it.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return maskPii(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth limit]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskPii(value.message),
      ...(typeof value.stack === "string" ? { stack: maskPii(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  // Only plain-ish objects are walked; a Date or a Buffer keeps its identity so
  // pino's own serialisers still recognise it.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactValue(entry, depth + 1);
  }
  return out;
}

/**
 * pino's `hooks.logMethod`. Must call `method` — a hook that returns without
 * invoking it drops the line silently, which would turn log hygiene into log loss.
 */
export function redactingLogMethod(
  this: Logger,
  args: Parameters<LogFn>,
  method: LogFn,
): void {
  const [first, second, ...rest] = args;
  // `log.info(obj, "msg")` and `log.info("msg")` are both legal; the message is the
  // string argument whichever position it is in.
  const redactedFirst = redactValue(first);
  const redactedSecond =
    typeof second === "string" ? maskPii(second) : redactValue(second);
  const forwarded: unknown[] = [redactedFirst];
  if (args.length > 1) forwarded.push(redactedSecond);
  forwarded.push(...rest);
  method.apply(this, forwarded as Parameters<LogFn>);
}
