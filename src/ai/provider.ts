/**
 * S05-01 / D12 — one primary model, one fallback, and the transport rules that
 * make "fallback" mean something.
 *
 * D12's own wording is the design constraint: *the fallback is a model choice,
 * not a mechanism*. So the mechanism lives here, once, and the two model ids
 * are configuration. That is also why this file contains no HTTP: a provider
 * adapter (one file per vendor) implements `generate`, and this wrapper owns
 * timeouts, retries, the circuit and the fallback decision. Swapping a vendor
 * cannot change the retry policy, and the retry policy cannot be re-tested per
 * vendor.
 *
 * The rules, from the development plan, implemented literally:
 *
 *  - **Per-call timeout**: 8s generation, 3s classification. Enforced here as
 *    well as passed to the adapter, because an adapter that ignores its
 *    `timeoutMs` would otherwise hang the guest's request forever.
 *  - **Retry twice with jitter, 429/5xx only.** A 400 is a contract bug in OUR
 *    request; retrying it burns quota and cannot succeed. Jitter matters as
 *    much as the retry: without it, every replica retries in lockstep against
 *    an upstream that is already struggling.
 *  - **Circuit-break to the secondary for 60 seconds.** After the primary's
 *    retries are exhausted, the primary is *skipped* — not merely deprioritised
 *    — for 60 seconds. Otherwise every request in the outage pays the full
 *    retry budget before falling back, which is the latency the fallback exists
 *    to avoid.
 *  - **Degrade honestly**: if both fail, throw `AiUnavailableError`. The caller
 *    turns that into "our team will reply" plus a request, which is a product
 *    state (S07-05), not a 500.
 */
import { createLogger, type Logger } from "../logging/index.ts";
import { incrementCounter } from "../metrics/counters.ts";

export interface AiRequest {
  system: string;
  prompt: string;
  /** JSON schema for provider-native structured outputs. */
  schema: object;
  /** D4/D12: always 0. Not configurable, so it is typed as a literal. */
  temperature: 0;
  timeoutMs: number;
}

export interface AiProvider {
  /** Pinned model id; it is what lands in `ai_runs.model_id`. */
  readonly modelId: string;
  /** Returns the provider's raw output. Parsing is `parseAiOutput`'s job. */
  generate(request: AiRequest): Promise<unknown>;
}

export class AiProviderError extends Error {
  readonly status: number | undefined;
  /** 429 and 5xx are worth another attempt; nothing else is. */
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "AiProviderError";
    this.status = options.status;
    this.retryable = options.retryable ?? (options.status === 429 || (options.status ?? 0) >= 500);
  }
}

/** Both providers failed. The caller degrades to "a human will reply". */
export class AiUnavailableError extends Error {
  readonly attempts: number;
  /**
   * S07-05 — the models that were TRIED, primary first.
   *
   * The outage path records an `ai_runs` row, and that row's `model_id` must not
   * name a model that never answered: per-model accuracy is sampled from this
   * table, and attributing a failure to `gemini-2.5-flash` would put an outage in
   * the denominator of that model's quality. The row records `model_id = "none"`
   * and lists these in `usage`, so the distinction survives.
   */
  readonly modelIds: readonly string[];

  constructor(attempts: number, cause?: unknown, modelIds: readonly string[] = []) {
    super(
      `no AI provider answered after ${attempts} attempt(s); the guest gets the outage path, not an error`,
    );
    this.name = "AiUnavailableError";
    this.attempts = attempts;
    this.modelIds = modelIds;
    if (cause !== undefined) this.cause = cause;
  }
}

export const GENERATION_TIMEOUT_MS = 8_000;
export const CLASSIFICATION_TIMEOUT_MS = 3_000;
export const RETRIES = 2;
export const BASE_RETRY_DELAY_MS = 250;
export const CIRCUIT_OPEN_MS = 60_000;

export interface ResilienceOptions {
  retries?: number;
  baseRetryDelayMs?: number;
  circuitOpenMs?: number;
  /** Injected for tests; production uses the real clock and `Math.random`. */
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export interface AiResult {
  modelId: string;
  raw: unknown;
  /** True when the primary was skipped or failed; recorded for alerting. */
  usedFallback: boolean;
  attempts: number;
  latencyMs: number;
}

export interface ResilientAi {
  generate(request: AiRequest): Promise<AiResult>;
  /** Exposed for the health endpoint and for tests; not for control flow. */
  isCircuitOpen(): boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A provider that never settles would hold the guest's request open for as long
 * as the socket lives. This rejects at `ms` and abandons the attempt; the
 * adapter's own abort is best-effort, ours is not.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AiProviderError(`${label} timed out after ${ms}ms`, { retryable: true }));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function withResilience(
  primary: AiProvider,
  fallback: AiProvider,
  options: ResilienceOptions = {},
): ResilientAi {
  const retries = options.retries ?? RETRIES;
  const baseDelay = options.baseRetryDelayMs ?? BASE_RETRY_DELAY_MS;
  const circuitMs = options.circuitOpenMs ?? CIRCUIT_OPEN_MS;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  // Silent by default: this module is used by scripts and tests, and an
  // unconfigured pino sink would print to stdout from production-shaped code.
  const logger = options.logger ?? createLogger("info", { enabled: false });

  if (primary.modelId === fallback.modelId) {
    // A "fallback" that is the same pinned model is the same failure mode
    // twice; the configuration would look resilient and not be.
    throw new RangeError("fallback model must differ from the primary model");
  }

  let circuitOpenUntil = 0;

  async function attempt(
    provider: AiProvider,
    request: AiRequest,
    label: string,
  ): Promise<unknown> {
    return withTimeout(provider.generate(request), request.timeoutMs, label);
  }

  async function withRetries(provider: AiProvider, request: AiRequest, label: string): Promise<unknown> {
    let lastError: unknown;
    for (let tryIndex = 0; tryIndex <= retries; tryIndex++) {
      try {
        return await attempt(provider, request, label);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AiProviderError && error.retryable;
        if (!retryable || tryIndex === retries) break;
        const delay = baseDelay * 2 ** tryIndex * (0.5 + random() / 2);
        logger.warn(
          {
            provider: label,
            attempt: tryIndex + 1,
            delayMs: Math.round(delay),
            error: error instanceof Error ? error.message : String(error),
          },
          "ai.provider.retry",
        );
        await sleep(delay);
      }
    }
    throw lastError;
  }

  return {
    isCircuitOpen(): boolean {
      return now() < circuitOpenUntil;
    },

    async generate(request: AiRequest): Promise<AiResult> {
      const startedAt = now();
      let attempts = 0;
      let primaryError: unknown;

      if (this.isCircuitOpen()) {
        logger.info(
          { modelId: primary.modelId, openForMs: circuitOpenUntil - now() },
          "ai.circuit.skip_primary",
        );
      } else {
        attempts += 1;
        try {
          const raw = await withRetries(primary, request, "primary");
          return {
            modelId: primary.modelId,
            raw,
            usedFallback: false,
            attempts,
            latencyMs: now() - startedAt,
          };
        } catch (error) {
          primaryError = error;
          circuitOpenUntil = now() + circuitMs;
          // S07-06 AC-3: one event per OUTAGE, not per request — this is the
          // metric that says "the primary has been down since 02:14".
          incrementCounter("ai_circuit_open_total", { model: primary.modelId });
          logger.error(
            {
              modelId: primary.modelId,
              openForMs: circuitMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "ai.circuit.open",
          );
        }
      }

      attempts += 1;
      try {
        const raw = await withRetries(fallback, request, "fallback");
        return {
          modelId: fallback.modelId,
          raw,
          usedFallback: true,
          attempts,
          latencyMs: now() - startedAt,
        };
      } catch (fallbackError) {
        logger.error(
          {
            primaryModelId: primary.modelId,
            fallbackModelId: fallback.modelId,
            primaryError: primaryError instanceof Error ? primaryError.message : undefined,
            fallbackError:
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          },
          "ai.provider.unavailable",
        );
        throw new AiUnavailableError(attempts, fallbackError, [primary.modelId, fallback.modelId]);
      }
    },
  };
}
