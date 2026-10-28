import { describe, expect, it } from "vitest";
import { planSync, writesOf, type RemoteState } from "./secrets-sync.ts";

/**
 * The decision half of `secrets:sync`. Every case here is a rule somebody will
 * otherwise discover by overwriting a production key: what is compared, what is only
 * observed, and what is never written at all.
 */
const empty = (): RemoteState => ({
  github: {
    repoSecrets: new Set<string>(),
    repoVariables: new Map<string, string>(),
    envSecrets: new Set<string>(),
    envVariables: new Map<string, string>(),
    environmentExists: true,
  },
  vercel: { target: "preview", entries: new Map<string, string | null>() },
});

const SOURCE: Record<string, string> = {
  APP_ENV: "staging",
  DATABASE_URL: "postgres://u:p@staging-db/concierge",
  LLM_API_KEY: "sk-live-0123456789",
  LLM_PRIMARY_MODEL: "gemini-3.6-flash",
  LLM_FALLBACK_MODEL: "gemini-3.5-flash-lite",
  EMAIL_FROM: "Concierge <desk@example.com>",
  REVIEW_API_URL: "https://api.staging.example.com",
  NEON_AUTH_ISSUER: "https://staging.neonauth.example.com/auth",
  VERCEL_PROJECT_ID: "prj_123",
};

const row = (plan: ReturnType<typeof planSync>, name: string) =>
  plan.rows.find((entry) => entry.name === name)!;

describe("planSync — routing", () => {
  it("sends each value to the store the manifest names, never a suffixed name", () => {
    const plan = planSync("staging", SOURCE, empty());
    expect(row(plan, "LLM_API_KEY")).toMatchObject({
      store: "github-environment",
      kind: "secret",
      target: "environment:staging",
    });
    expect(row(plan, "LLM_PRIMARY_MODEL")).toMatchObject({
      store: "github-environment",
      kind: "variable",
    });
    expect(row(plan, "REVIEW_API_URL").target).toBe("vercel:preview");
    expect(row(plan, "VERCEL_PROJECT_ID").target).toBe("repo");
  });

  it("maps prod to the production environment and the production Vercel target", () => {
    const plan = planSync("prod", { ...SOURCE, APP_ENV: "prod" }, empty());
    expect(row(plan, "LLM_API_KEY").target).toBe("environment:production");
    expect(row(plan, "REVIEW_API_URL").target).toBe("vercel:production");
  });

  it("never writes a value the host supplies", () => {
    const plan = planSync("staging", SOURCE, empty());
    expect(row(plan, "APP_ENV").action).toBe("runtime");
    expect(writesOf(plan).map((entry) => entry.name)).not.toContain("APP_ENV");
  });
});

describe("planSync — deciding whether to write", () => {
  it("creates what is absent", () => {
    const plan = planSync("staging", SOURCE, empty());
    expect(row(plan, "LLM_API_KEY").action).toBe("create");
    expect(row(plan, "DATABASE_URL").action).toBe("create");
  });

  it("compares VARIABLES and skips the identical ones", () => {
    const state = empty();
    state.github!.envVariables.set("LLM_PRIMARY_MODEL", "gemini-3.6-flash");
    const plan = planSync("staging", SOURCE, state);
    expect(row(plan, "LLM_PRIMARY_MODEL").action).toBe("skip-equal");
  });

  it("updates a variable whose value changed", () => {
    const state = empty();
    state.github!.envVariables.set("LLM_PRIMARY_MODEL", "gemini-1.5-pro");
    const plan = planSync("staging", SOURCE, state);
    expect(row(plan, "LLM_PRIMARY_MODEL").action).toBe("update");
  });

  it("does NOT claim to compare a secret — it is write-only", () => {
    // The distinction the report must preserve: `skip-present` means "it is there and
    // I could not look", not "it matches".
    const state = empty();
    state.github!.envSecrets.add("LLM_API_KEY");
    const plan = planSync("staging", SOURCE, state);
    expect(row(plan, "LLM_API_KEY").action).toBe("skip-present");
    expect(row(plan, "LLM_API_KEY").detail).toMatch(/write-only/);
    expect(plan.writes).toBeGreaterThan(0); // other rows still planned
  });

  it("rewrites a present secret only with --force", () => {
    const state = empty();
    state.github!.envSecrets.add("LLM_API_KEY");
    const plan = planSync("staging", SOURCE, state, { force: true });
    expect(row(plan, "LLM_API_KEY").action).toBe("update");
  });

  it("compares a Vercel value when Vercel returned one", () => {
    const state = empty();
    state.vercel!.entries.set("REVIEW_API_URL", "https://api.staging.example.com");
    expect(row(planSync("staging", SOURCE, state), "REVIEW_API_URL").action).toBe("skip-equal");

    state.vercel!.entries.set("REVIEW_API_URL", "https://old.example.com");
    expect(row(planSync("staging", SOURCE, state), "REVIEW_API_URL").action).toBe("update");
  });

  it("treats a Vercel value it cannot read as present, unverified", () => {
    const state = empty();
    state.vercel!.entries.set("REVIEW_API_URL", null);
    expect(row(planSync("staging", SOURCE, state), "REVIEW_API_URL").action).toBe("skip-present");
  });

  it("decides nothing when the store cannot be read", () => {
    const plan = planSync("staging", SOURCE, { github: null, vercel: null });
    expect(row(plan, "LLM_API_KEY").action).toBe("blocked");
    expect(plan.writes).toBe(0);
  });

  it("does not call an either/or partner absent when the other half is set", () => {
    const plan = planSync("staging", SOURCE, empty());
    expect(plan.absent).not.toContain("NEON_AUTH_BASE_URL");
    expect(plan.absent).not.toContain("NEON_AUTH_ISSUER");
  });

  it("records values that are required but absent from the file", () => {
    const thin = { APP_ENV: "staging", DATABASE_URL: "postgres://u:p@h/d" };
    const plan = planSync("staging", thin, empty());
    expect(plan.absent).toContain("LLM_API_KEY");
    expect(row(plan, "LLM_API_KEY").action).toBe("skip-absent-from-file");
  });

  it("honours --only", () => {
    const plan = planSync("staging", SOURCE, empty(), { only: ["LLM_API_KEY"] });
    expect(plan.rows.map((entry) => entry.name)).toEqual(["LLM_API_KEY"]);
  });

  it("counts what it will write", () => {
    const plan = planSync("staging", SOURCE, empty());
    expect(plan.counts.create).toBe(plan.rows.filter((r) => r.action === "create").length);
    expect(plan.writes).toBe(plan.counts.create + plan.counts.update);
  });
});
