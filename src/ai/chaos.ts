/**
 * S07-05 — a deliberate way to break the AI, so the outage path can be proven
 * without waiting for an outage.
 *
 * The AC is "kill the AI mid-conversation; the guest still gets an honest
 * message". Proving it against a real provider means either waiting, or pulling
 * a plug you do not have. `AI_FAIL_MODE` makes the failure an input:
 *
 *  - `none` (default) — pass everything through. The wrapper still exists, so
 *    the ordinary path is the same code path.
 *  - `once` — the next generation fails, then everything is normal again. This
 *    is the "mid-conversation" case: one answered turn, one outage turn, one
 *    answered turn, in one test or one staging session.
 *  - `always` — every generation fails. This is the "provider is down" case.
 *
 * ## Why it refuses to be on in production
 *
 * A host that can be made to fail its AI by an environment variable is a host
 * where a copy-pasted `.env.staging` becomes an outage. `loadChaosMode` therefore
 * **throws** when the mode is anything but `none` under `APP_ENV=prod` — at boot,
 * where it is a five-second fix, rather than at 3am through a guest message.
 *
 * ## Why the failures look real
 *
 * The failure is an `AiUnavailableError` from the same class the real wrapper
 * throws, with the same shape (`attempts`, `modelIds`), so the outage path is
 * exercised exactly as it is in production: one `ai_runs` row, one
 * `message_failed` event, the catalogue "a person will reply" string, and a
 * captured request. A chaos hook that invented its own error type would prove
 * only that the error type is handled.
 */
import { ConfigError, isEnvName, type EnvName } from "../config/env.ts";
import { AiUnavailableError, type AiRequest, type AiResult, type ResilientAi } from "./provider.ts";

export const CHAOS_MODES = ["none", "once", "always"] as const;
export type ChaosMode = (typeof CHAOS_MODES)[number];

/** True when the variable silences nothing. Anything else is chaos. */
export function isChaosMode(value: string): value is ChaosMode {
  return (CHAOS_MODES as readonly string[]).includes(value);
}

export function loadChaosMode(
  source: Record<string, string | undefined>,
  appEnv: EnvName = "local",
): ChaosMode {
  const raw = (source["AI_FAIL_MODE"] ?? "").trim().toLowerCase();
  if (raw === "") return "none";
  if (!isChaosMode(raw)) {
    throw new ConfigError(`AI_FAIL_MODE must be one of ${CHAOS_MODES.join(" | ")}, got "${raw}"`);
  }
  if (raw !== "none" && appEnv === "prod") {
    throw new ConfigError(
      `AI_FAIL_MODE=${raw} is refused when APP_ENV=prod: a host that can be made to ` +
        "fail its AI by an environment variable is a host where one copied file is an outage.",
    );
  }
  return raw;
}

export function chaosModeFromEnv(source: NodeJS.ProcessEnv): ChaosMode {
  const raw = source["APP_ENV"] ?? "";
  const appEnv: EnvName = isEnvName(raw) ? raw : "local";
  return loadChaosMode(source, appEnv);
}

/**
 * Wraps a resilient AI so it fails on purpose.
 *
 * `once` is stateful and consumes the first call: the counter lives in the
 * closure, so a long-lived server fails one request, not one per process start.
 * The failure is raised BEFORE delegating, so nothing is spent and no provider
 * is contacted.
 */
export function withChaos(ai: ResilientAi, mode: ChaosMode): ResilientAi {
  if (mode === "none") return ai;
  let remaining = mode === "once" ? 1 : Number.POSITIVE_INFINITY;

  return {
    async generate(request: AiRequest): Promise<AiResult> {
      if (remaining > 0) {
        remaining -= 1;
        throw new AiUnavailableError(0, new Error(`AI_FAIL_MODE=${mode}`));
      }
      return ai.generate(request);
    },
    // The circuit state is the wrapped instance's: a deliberate failure is not a
    // provider outage, and letting it trip the real circuit would make a chaos
    // run contaminate the next 60 seconds of genuine traffic.
    isCircuitOpen: (): boolean => ai.isCircuitOpen(),
  };
}
