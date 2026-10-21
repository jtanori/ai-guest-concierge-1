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
