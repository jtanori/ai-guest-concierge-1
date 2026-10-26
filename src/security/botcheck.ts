/**
 * S07-04 AC-1 — "Turnstile (or equivalent) on the first message".
 *
 * The rate limiter (same item) bounds a client that is already talking. This
 * bounds the client that has not started: a proof that a browser, not a script,
 * opened the conversation. The two are complementary and neither replaces the
 * other — a bot farm with a valid token is stopped by the rate limiter, and a
 * script that paces itself under every limit is stopped by this.
 *
 * ## The vendor is behind a port, and the port is what was tested
 *
 * Cloudflare Turnstile is a third-party data processor: enabling it means guest
 * IP addresses and browser metadata reach Cloudflare, which is exactly what
 * DEC-9 / W00-18 (privacy notice + DPA) has to cover before production. So the
 * decision this code takes is the charter's stated default: **implement the
 * port, leave it off in local, and refuse to boot without a secret in
 * staging/prod** — the same shape as `GUEST_COOKIE_SECRET`, and for the same
 * reason. A host that silently runs without the control it was configured to use
 * is how "we have bot protection" becomes a claim nobody checked.
 *
 * ## Why `fetch` and not the SDK
 *
 * One POST, one JSON body, no supply chain — the same reasoning as DEC-2/DEC-3.
 * `fetchImpl` is injected so the tests exercise the real call shape without a
 * network, and so a proxy or a regional endpoint needs no code change.
 *
 * ## What is never logged
 *
 * The token and the secret. Turnstile tokens are single-use but still
 * credentials during their lifetime, and a verify failure logged with the token
 * is a replay window in a log file.
 */
import { ConfigError, isEnvName, type EnvName } from "../config/env.ts";
import { createLogger, type Logger } from "../logging/index.ts";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const BOTCHECK_TIMEOUT_MS = 3_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BotCheckConfig {
  /**
   * `enforced` — a missing or failing token blocks the first message.
   * `disabled` — local only, and logged loudly at boot.
   */
  mode: "enforced" | "disabled";
  secret: string;
  timeoutMs: number;
}

/**
 * Local may run without a secret; anything else may not.
 *
 * Deliberately the same rule as `loadGuestConfig`: a control that is "on in
 * production if someone remembered" is off. The failure is at boot, where it can
 * be fixed, rather than on the first guest's message, where it cannot.
 */
export function loadBotCheckConfig(
  source: Record<string, string | undefined>,
  appEnv: EnvName = "local",
): BotCheckConfig {
  const secret = (source["TURNSTILE_SECRET"] ?? "").trim();
  if (secret === "") {
    if (appEnv === "local") {
      return { mode: "disabled", secret: "", timeoutMs: BOTCHECK_TIMEOUT_MS };
    }
    throw new ConfigError(
      `TURNSTILE_SECRET is required when APP_ENV=${appEnv}. The first guest message ` +
        "is bot-checked in every environment that has real guests.",
    );
  }
  const timeoutMs = Number(source["TURNSTILE_TIMEOUT_MS"] ?? BOTCHECK_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new ConfigError("TURNSTILE_TIMEOUT_MS must be a positive integer");
  }
  return { mode: "enforced", secret, timeoutMs };
}

export function botCheckConfigFromEnv(source: NodeJS.ProcessEnv): BotCheckConfig {
  const raw = source["APP_ENV"] ?? "";
  const appEnv: EnvName = isEnvName(raw) ? raw : "local";
  return loadBotCheckConfig(source, appEnv);
}

export interface BotCheckResult {
  ok: boolean;
  /** Machine-readable cause: `disabled`, `missing_token`, `vendor_rejected`, `vendor_unreachable`. */
  reason: "disabled" | "missing_token" | "vendor_rejected" | "vendor_unreachable" | "verified";
  /** Turnstile's own error codes, when it gave any. Never the token. */
  detail?: string;
}

export interface VerifyInput {
  token: string | null | undefined;
  /** Passed to the vendor for its own heuristics; never stored by us. */
  remoteIp?: string | null;
  /**
   * True only when this is the conversation's first message. Turnstile tokens
   * are single use, so a check on every message would reject a legitimate
   * guest's second turn.
   */
  firstMessage: boolean;
}

/**
 * Verifies one token.
 *
 * A token is not required for a non-first message, and not required at all when
 * the config is disabled — in both cases the result says *why* it passed, so a
 * "no bot protection" log line is distinguishable from a verified browser.
 */
export async function verifyBotCheck(
  config: BotCheckConfig,
  input: VerifyInput,
  fetchImpl: FetchLike = fetch,
  logger: Logger = createLogger("info", { enabled: false }),
): Promise<BotCheckResult> {
  if (!input.firstMessage) return { ok: true, reason: "disabled" };
  if (config.mode === "disabled") return { ok: true, reason: "disabled" };
  if (typeof input.token !== "string" || input.token.trim() === "") {
    return { ok: false, reason: "missing_token" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    const body = new URLSearchParams({ secret: config.secret, response: input.token });
    if (typeof input.remoteIp === "string" && input.remoteIp !== "") {
      body.set("remoteip", input.remoteIp);
    }
    response = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    // Unreachable vendor is NOT a pass. A bot check that fails open is a bot
    // check an attacker can turn off by blackholing one hostname.
    logger.error(
      { error: error instanceof Error ? error.name : "unknown" },
      "botcheck.vendor_unreachable",
    );
    return { ok: false, reason: "vendor_unreachable" };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    logger.error({ status: response.status }, "botcheck.vendor_unreachable");
    return { ok: false, reason: "vendor_unreachable", detail: `HTTP ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "vendor_unreachable", detail: "response was not JSON" };
  }
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  if (record["success"] === true) return { ok: true, reason: "verified" };

  const codes = Array.isArray(record["error-codes"])
    ? (record["error-codes"] as unknown[]).filter((code): code is string => typeof code === "string")
    : [];
  logger.warn({ codes }, "botcheck.rejected");
  return {
    ok: false,
    reason: "vendor_rejected",
    ...(codes.length === 0 ? {} : { detail: codes.join(",") }),
  };
}
