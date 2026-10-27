import { describe, expect, it } from "vitest";
import {
  ConfigError,
  isEnvName,
  loadConfig,
  loadLlmConfig,
  resolveBootMode,
  resolveDeploymentEnvironments,
} from "./env.ts";

const PG = (db: string): string => `postgres://u:p@host:5432/${db}`;

describe("loadConfig (W00-13)", () => {
  it("defaults to local and requires a Postgres DATABASE_URL", () => {
    const cfg = loadConfig({ DATABASE_URL: PG("dev") });
    expect(cfg.env).toBe("local");
    expect(cfg.databaseUrl).toBe(PG("dev"));
    expect(cfg.logLevel).toBe("debug");
  });

  it("refuses to boot with no DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("refuses a non-Postgres DATABASE_URL", () => {
    expect(() => loadConfig({ DATABASE_URL: "mysql://u:p@h/d" })).toThrow(ConfigError);
  });

  it("refuses an unknown APP_ENV", () => {
    expect(() =>
      loadConfig({ APP_ENV: "qa", DATABASE_URL: PG("qa") }),
    ).toThrow(ConfigError);
  });

  it("accepts staging and prod names", () => {
    expect(isEnvName("staging")).toBe(true);
    expect(isEnvName("prod")).toBe(true);
    expect(isEnvName("production")).toBe(false);
    expect(loadConfig({ APP_ENV: "prod", DATABASE_URL: PG("p") }).logLevel).toBe(
      "info",
    );
  });
});

describe("resolveDeploymentEnvironments — the no-shared-database gate (W00-13)", () => {
  it("accepts three distinct databases", () => {
    const resolved = resolveDeploymentEnvironments({
      localUrl: PG("local"),
      stagingUrl: PG("staging"),
      prodUrl: PG("prod"),
    });
    expect(resolved.stagingUrl).toBe(PG("staging"));
    expect(resolved.prodUrl).toBe(PG("prod"));
  });

  it("FAILS if staging and prod share a database (the AC)", () => {
    const shared = PG("one-db-for-both");
    expect(() =>
      resolveDeploymentEnvironments({ stagingUrl: shared, prodUrl: shared }),
    ).toThrow(/staging and prod must NOT share a database/);
  });

  it("FAILS if either environment reuses the local database", () => {
    expect(() =>
      resolveDeploymentEnvironments({
        localUrl: PG("local"),
        stagingUrl: PG("local"),
        prodUrl: PG("prod"),
      }),
    ).toThrow(/local development database/);
    expect(() =>
      resolveDeploymentEnvironments({
        localUrl: PG("local"),
        stagingUrl: PG("staging"),
        prodUrl: PG("local"),
      }),
    ).toThrow(/local development database/);
  });

  it("FAILS fast on missing or malformed URLs", () => {
    // The messages name the file argument, not a STAGING_DATABASE_URL variable:
    // no such name exists anywhere, and pointing an operator at a name nothing
    // reads is how the suffixed-name pattern comes back.
    expect(() => resolveDeploymentEnvironments({ prodUrl: PG("p") })).toThrow(
      /staging DATABASE_URL missing/,
    );
    expect(() =>
      resolveDeploymentEnvironments({ stagingUrl: PG("s") }),
    ).toThrow(/prod DATABASE_URL missing/);
    expect(() =>
      resolveDeploymentEnvironments({ stagingUrl: "mysql://x", prodUrl: PG("p") }),
    ).toThrow(/not Postgres/);
  });
});

describe("loadLlmConfig (S05-01 / DEC-2)", () => {
  const base = {
    LLM_PRIMARY_MODEL: "gpt-4.1-mini-2025-04-14",
    LLM_FALLBACK_MODEL: "gpt-4o-mini-2024-07-18",
  };

  it("never defaults a model id: both are required", () => {
    expect(() => loadLlmConfig({})).toThrow(/LLM_PRIMARY_MODEL is required/);
    expect(() => loadLlmConfig({ LLM_PRIMARY_MODEL: base.LLM_PRIMARY_MODEL })).toThrow(
      /LLM_FALLBACK_MODEL is required/,
    );
  });

  it("rejects a floating alias, which is the whole point of pinning", () => {
    expect(() =>
      loadLlmConfig({ ...base, LLM_PRIMARY_MODEL: "gpt-4.1-mini-latest" }),
    ).toThrow(/floating alias/);
    expect(() => loadLlmConfig({ ...base, LLM_FALLBACK_MODEL: "gemini-pro@latest" })).toThrow(
      /floating alias/,
    );
  });

  it("rejects the same model twice, and a non-http base URL", () => {
    expect(() =>
      loadLlmConfig({ ...base, LLM_FALLBACK_MODEL: base.LLM_PRIMARY_MODEL }),
    ).toThrow(/must differ/);
    expect(() => loadLlmConfig({ ...base, LLM_BASE_URL: "api.openai.com" })).toThrow(
      /http\(s\) URL/,
    );
  });

  it("allows a missing key locally (stub provider) but not in prod", () => {
    const local = loadLlmConfig(base, "local");
    expect(local.apiKey).toBe("");
    expect(local.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(local.timeoutMs).toBe(8000);
    expect(() => loadLlmConfig(base, "staging")).toThrow(/LLM_API_KEY is required/);
    expect(() => loadLlmConfig(base, "prod")).toThrow(/LLM_API_KEY is required/);
    expect(loadLlmConfig({ ...base, LLM_API_KEY: "sk-test" }, "prod").apiKey).toBe("sk-test");
  });

  it("S07-06: defaults the retry budget to the plan's two, and bounds it", () => {
    expect(loadLlmConfig(base, "local").retries).toBe(2);
    expect(loadLlmConfig({ ...base, LLM_RETRIES: "0" }, "local").retries).toBe(0);
    expect(loadLlmConfig({ ...base, LLM_RETRIES: "4" }, "local").retries).toBe(4);
    // The ceiling exists because the guest is the one waiting on the retries.
    expect(() => loadLlmConfig({ ...base, LLM_RETRIES: "5" }, "local")).toThrow(/LLM_RETRIES/);
    expect(() => loadLlmConfig({ ...base, LLM_RETRIES: "-1" }, "local")).toThrow(/LLM_RETRIES/);
    expect(() => loadLlmConfig({ ...base, LLM_RETRIES: "two" }, "local")).toThrow(/LLM_RETRIES/);
  });
});

describe("resolveBootMode — fail fast outside local (W00-13)", () => {
  it("lets local be tolerant: a developer's shell is not a deployment", () => {
    expect(resolveBootMode({}).mode).toBe("tolerant");
    expect(resolveBootMode({ APP_ENV: "local" }).mode).toBe("tolerant");
  });

  it("is strict in staging and prod by default", () => {
    expect(resolveBootMode({ APP_ENV: "staging" }).mode).toBe("strict");
    expect(resolveBootMode({ APP_ENV: "prod" }).mode).toBe("strict");
  });

  it("allows an explicit opt-out on staging, for preview hosts", () => {
    const decision = resolveBootMode({ APP_ENV: "staging", ALLOW_DEGRADED_BOOT: "1" });
    expect(decision.mode).toBe("tolerant");
    // The reason is logged verbatim, so it has to say that this is not a real
    // staging deployment.
    expect(decision.reason).toMatch(/must never be mistaken/);
  });

  it("REFUSES the opt-out in prod — one copied file must not be an outage", () => {
    expect(() => resolveBootMode({ APP_ENV: "prod", ALLOW_DEGRADED_BOOT: "1" })).toThrow(
      /refused when APP_ENV=prod/,
    );
    // And `true` is the same request, not a different one.
    expect(() => resolveBootMode({ APP_ENV: "prod", ALLOW_DEGRADED_BOOT: "true" })).toThrow(
      ConfigError,
    );
  });

  it("refuses an unknown APP_ENV rather than defaulting to tolerant", () => {
    expect(() => resolveBootMode({ APP_ENV: "production" })).toThrow(/APP_ENV must be one of/);
  });

  it("treats a near-miss flag value as not set", () => {
    // "yes", "0", "on" are not "1"/"true": guessing intent here turns a typo into a
    // degraded production-looking host.
    for (const flag of ["0", "yes", "on", "false"]) {
      expect(resolveBootMode({ APP_ENV: "staging", ALLOW_DEGRADED_BOOT: flag }).mode, flag).toBe(
        "strict",
      );
    }
  });
});
