import { describe, expect, it } from "vitest";
import {
  ConfigError,
  isEnvName,
  loadConfig,
  loadLlmConfig,
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
    expect(() => resolveDeploymentEnvironments({ prodUrl: PG("p") })).toThrow(
      /STAGING_DATABASE_URL/,
    );
    expect(() =>
      resolveDeploymentEnvironments({ stagingUrl: PG("s") }),
    ).toThrow(/PROD_DATABASE_URL/);
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
});
