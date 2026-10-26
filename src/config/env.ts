/**
 * Application environment resolution.
 *
 * W00-13 — three environments: local, staging, prod. Nothing may boot with a
 * configuration that blurs them. This module is deliberately small and
 * dependency-free so every entry point (web server, worker, seed script,
 * CI job) resolves through it.
 */

export const ENV_NAMES = ["local", "staging", "prod"] as const;

export type EnvName = (typeof ENV_NAMES)[number];

export function isEnvName(value: string): value is EnvName {
  return (ENV_NAMES as readonly string[]).includes(value);
}

export interface AppConfig {
  env: EnvName;
  databaseUrl: string;
  logLevel: string;
  appName: string;
}

export class ConfigError extends Error {}

export function isPostgresUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "postgres:" ||
      parsed.protocol === "postgresql:" ||
      parsed.protocol === "pg:"
    );
  } catch {
    return false;
  }
}

/**
 * Resolve config for the process from a raw environment record.
 * Throws ConfigError instead of defaulting to anything unsafe:
 * - APP_ENV must name one of the three environments (default local only when
 *   the variable is entirely absent, e.g. a developer's shell).
 * - DATABASE_URL must be present and a Postgres URL.
 */
export function loadConfig(source: Record<string, string | undefined>): AppConfig {
  const rawEnv = source["APP_ENV"] ?? "local";
  if (!isEnvName(rawEnv)) {
    throw new ConfigError(
      `APP_ENV must be one of ${ENV_NAMES.join(" | ")}, got "${rawEnv}"`,
    );
  }

  const databaseUrl = source["DATABASE_URL"];
  if (!databaseUrl) {
    throw new ConfigError(
      `DATABASE_URL is required (APP_ENV=${rawEnv}). ` +
        "Every environment points at its own database; none are shared.",
    );
  }
  if (!isPostgresUrl(databaseUrl)) {
    throw new ConfigError(
      `DATABASE_URL for APP_ENV=${rawEnv} is not a Postgres URL. ` +
        "Refusing to boot against a non-Postgres database.",
    );
  }

  const logLevel = source["LOG_LEVEL"] ?? (rawEnv === "local" ? "debug" : "info");

  return {
    env: rawEnv,
    databaseUrl,
    logLevel,
    appName: source["APP_NAME"] ?? "ai-guest-concierge",
  };
}

/**
 * The W00-13 gate as a pure function, so CI can enforce it before anything
 * deploys: staging and prod must point at DIFFERENT databases, and neither
 * may point at the local one.
 */
export function resolveDeploymentEnvironments(input: {
  localUrl?: string;
  stagingUrl?: string;
  prodUrl?: string;
}): { localUrl: string | undefined; stagingUrl: string; prodUrl: string } {
  const { localUrl, stagingUrl, prodUrl } = input;

  if (!stagingUrl || !isPostgresUrl(stagingUrl)) {
    throw new ConfigError("STAGING_DATABASE_URL missing or not Postgres");
  }
  if (!prodUrl || !isPostgresUrl(prodUrl)) {
    throw new ConfigError("PROD_DATABASE_URL missing or not Postgres");
  }
  if (stagingUrl === prodUrl) {
    throw new ConfigError(
      "staging and prod must NOT share a database (W00-13 exit criterion)",
    );
  }
  if (localUrl && (stagingUrl === localUrl || prodUrl === localUrl)) {
    throw new ConfigError(
      "staging/prod must not point at the local development database",
    );
  }

  return { localUrl, stagingUrl, prodUrl };
}

/**
 * S04-02 / DEC-3 — the embedding provider's settings, resolved the same way as
 * everything else: from the environment, with no silent default for the secret.
 *
 * The model default (`text-embedding-3-small`) is the one that emits the 1536
 * dimensions D3 locked. It is a DEFAULT and not a constraint: pointing
 * EMBEDDING_MODEL at a model with a different width is allowed here and fails
 * loudly at `assertEmbeddingDimension` before anything reaches Postgres, which
 * is the right place for that failure — the provider is replaceable, the column
 * is not.
 */
export interface EmbeddingConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  /** How many chunk texts go in one provider call. */
  batchSize: number;
}

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com/v1";

export function loadEmbeddingConfig(source: Record<string, string | undefined>): EmbeddingConfig {
  const apiKey = (source["EMBEDDING_API_KEY"] ?? "").trim();
  if (apiKey === "") {
    throw new ConfigError(
      "EMBEDDING_API_KEY is required to chunk and embed published articles " +
        "(S04-02). Refusing to start without it rather than writing rows with " +
        "a null embedding.",
    );
  }

  const baseUrl = (source["EMBEDDING_BASE_URL"] ?? DEFAULT_EMBEDDING_BASE_URL).trim();
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new ConfigError(`EMBEDDING_BASE_URL must be an http(s) URL, got "${baseUrl}"`);
  }

  const timeoutMs = Number(source["EMBEDDING_TIMEOUT_MS"] ?? 20_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new ConfigError("EMBEDDING_TIMEOUT_MS must be a positive integer");
  }

  const batchSize = Number(source["EMBEDDING_BATCH_SIZE"] ?? 16);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128) {
    throw new ConfigError("EMBEDDING_BATCH_SIZE must be an integer in 1..128");
  }

  return {
    apiKey,
    model: (source["EMBEDDING_MODEL"] ?? DEFAULT_EMBEDDING_MODEL).trim(),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    timeoutMs,
    batchSize,
  };
}

/**
 * S05-01 / DEC-2 — LLM configuration.
 *
 * There is NO default model id, and that is the point. "Pin model versions
 * explicitly; never call a floating alias" is a rule that a default violates by
 * existing: `gpt-4o` today and `gpt-4o` in six months are different models, and
 * the only way to notice is to have written the dated id down. So both ids are
 * required wherever the AI layer runs, and a name that looks like a floating
 * alias is refused here rather than discovered in a diff of guest answers.
 *
 * The key is required only outside `local`: CI and a developer's shell run with
 * a stub provider (no network, no cost), production must not boot without a
 * key and then fail on the first guest message.
 */
export interface LlmConfig {
  apiKey: string;
  primaryModel: string;
  fallbackModel: string;
  baseUrl: string;
  timeoutMs: number;
}

export const DEFAULT_LLM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** `-latest`, `@latest`, or a bare family name: all float. */
function assertPinnedModel(name: string, variable: string): void {
  if (name === "") throw new ConfigError(`${variable} is required: model ids are pinned, never defaulted`);
  if (/-latest$|@latest$/i.test(name)) {
    throw new ConfigError(`${variable} must be a dated, pinned model id, not the floating alias "${name}"`);
  }
}

export function loadLlmConfig(
  source: Record<string, string | undefined>,
  appEnv: EnvName = "local",
): LlmConfig {
  const primaryModel = (source["LLM_PRIMARY_MODEL"] ?? "").trim();
  const fallbackModel = (source["LLM_FALLBACK_MODEL"] ?? "").trim();
  assertPinnedModel(primaryModel, "LLM_PRIMARY_MODEL");
  assertPinnedModel(fallbackModel, "LLM_FALLBACK_MODEL");
  if (primaryModel === fallbackModel) {
    throw new ConfigError(
      "LLM_FALLBACK_MODEL must differ from LLM_PRIMARY_MODEL; the same model twice is the same failure twice",
    );
  }

  const apiKey = (source["LLM_API_KEY"] ?? "").trim();
  if (apiKey === "" && appEnv !== "local") {
    throw new ConfigError(
      `LLM_API_KEY is required when APP_ENV=${appEnv}. Refusing to boot into a ` +
        "configuration that cannot answer a single guest message.",
    );
  }

  const baseUrl = (source["LLM_BASE_URL"] ?? DEFAULT_LLM_BASE_URL).trim();
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new ConfigError(`LLM_BASE_URL must be an http(s) URL, got "${baseUrl}"`);
  }

  const timeoutMs = Number(source["LLM_TIMEOUT_MS"] ?? 8_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new ConfigError("LLM_TIMEOUT_MS must be a positive integer");
  }

  return {
    apiKey,
    primaryModel,
    fallbackModel,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    timeoutMs,
  };
}
