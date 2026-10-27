import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkReadiness, maskSecret, scrubSecrets } from "./preflight.ts";
import { VARIABLES, requirementsFor } from "./manifest.ts";

/**
 * W00-13 — the readiness report is what stands between a misconfigured host and a
 * guest who finds out first. Its two jobs are "find every gap in one pass" and
 * "never print a secret", and both are asserted here rather than trusted.
 */

/** A complete staging environment. Tests subtract from it, never rebuild it. */
const STAGING: Record<string, string> = {
  APP_ENV: "staging",
  DATABASE_URL: "postgres://concierge:pw@staging-db.example.com/concierge",
  NEON_AUTH_ISSUER: "https://staging.neonauth.example.com/concierge/auth",
  NEON_AUTH_JWKS_URL: "https://staging.neonauth.example.com/concierge/auth/.well-known/jwks.json",
  GUEST_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
  GUEST_PUBLIC_URL: "https://staging.chat.example.com",
  LLM_PRIMARY_MODEL: "gemini-2.5-flash",
  LLM_FALLBACK_MODEL: "gemini-2.5-flash-lite",
  LLM_API_KEY: "AIzaSyTestKeyValue1234567890",
  EMBEDDING_API_KEY: "sk-test-embedding-key-1234567890",
  TURNSTILE_SECRET: "0x4AAAAAAAtestsecretvalue123",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAAsitekey",
  EMAIL_FROM: "Concierge <desk@example.com>",
  EMAIL_API_KEY: "re_testkeyvalue1234567890",
  EMAIL_ESCALATION_FALLBACK: "oncall@example.com",
  CONSOLE_BASE_URL: "https://console.staging.example.com",
  REVIEW_API_URL: "https://api.staging.example.com",
};

const without = (...keys: string[]): Record<string, string> => {
  const copy = { ...STAGING };
  for (const key of keys) delete copy[key];
  return copy;
};

describe("checkReadiness — a complete environment", () => {
  it("is ready, with nothing to report", () => {
    const report = checkReadiness(STAGING, "staging");
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it("reports EVERY gap in one pass, not the first", () => {
    // An operator fixing a deploy should need one round trip, not seven.
    const report = checkReadiness(
      without("TURNSTILE_SECRET", "EMAIL_API_KEY", "GUEST_PUBLIC_URL"),
      "staging",
    );
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.variable).sort()).toEqual([
      "EMAIL_API_KEY",
      "GUEST_PUBLIC_URL",
      "TURNSTILE_SECRET",
    ]);
  });

  it("names the consequence, not just the variable", () => {
    const report = checkReadiness(without("TURNSTILE_SECRET"), "staging");
    expect(report.errors[0]!.message).toMatch(/bot check/);
  });
});

describe("checkReadiness — the traps", () => {
  it("refuses a file whose APP_ENV contradicts the environment being checked", () => {
    // `.env.staging` with APP_ENV=local is how a staging check passes while
    // actually exercising a developer's shell.
    const report = checkReadiness({ ...STAGING, APP_ENV: "local" }, "staging");
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.variable)).toContain("APP_ENV");
  });

  it("treats a placeholder secret as missing", () => {
    for (const placeholder of ["changeme", "TODO", "xxx", "placeholder"]) {
      const report = checkReadiness({ ...STAGING, LLM_API_KEY: placeholder }, "staging");
      expect(report.ok, placeholder).toBe(false);
      expect(report.errors.map((e) => e.variable), placeholder).toContain("LLM_API_KEY");
    }
  });

  it("accepts either member of the auth one-of group, and demands one of them", () => {
    const withBaseUrl = { ...without("NEON_AUTH_ISSUER"), NEON_AUTH_BASE_URL: "https://auth.example.com" };
    expect(checkReadiness(withBaseUrl, "staging").errors).toEqual([]);

    const withNeither = without("NEON_AUTH_ISSUER");
    const report = checkReadiness(withNeither, "staging");
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.variable)).toContain(
      "NEON_AUTH_ISSUER | NEON_AUTH_BASE_URL",
    );
  });

  it("refuses AI_FAIL_MODE in prod — one copied file must not be an outage", () => {
    const report = checkReadiness({ ...STAGING, APP_ENV: "prod", AI_FAIL_MODE: "always" }, "prod");
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.variable)).toContain("AI_FAIL_MODE");
  });

  it("names a one-of group once, with a variable to act on", () => {
    // `NEON_AUTH_ISSUER | NEON_AUTH_BASE_URL` is one requirement with two spellings.
    // The report names one representative in `missing` (a name the operator can set)
    // and one finding in `errors` (the group), never two of either.
    const report = checkReadiness(without("NEON_AUTH_ISSUER", "NEON_AUTH_BASE_URL"), "staging");
    expect(report.missing.filter((name) => name.startsWith("NEON_AUTH_ISSUER"))).toHaveLength(1);
    const groupFindings = report.errors.filter((entry) => entry.variable.includes("|"));
    expect(groupFindings).toHaveLength(1);
    expect(groupFindings[0]!.message).toMatch(/one of these is required/);

    // Supplying either member satisfies it.
    const satisfied = checkReadiness({ ...without("NEON_AUTH_BASE_URL") }, "staging");
    expect(satisfied.missing.filter((name) => name.startsWith("NEON_AUTH"))).toEqual([]);
  });

  it("reports at most one finding per variable", () => {
    // The manifest and the loader both notice a missing TURNSTILE_SECRET; printing
    // it twice trains people to skim.
    const report = checkReadiness(without("TURNSTILE_SECRET"), "staging");
    const named = report.errors.filter((e) => e.variable === "TURNSTILE_SECRET");
    expect(named).toHaveLength(1);
  });
});

describe("checkReadiness — the consumer filter", () => {
  it("keeps this consumer's errors fatal and downgrades the other tier's", () => {
    // The regression that mattered: a filter which emptied the error list instead of
    // removing only the other tier's findings let a strict staging host boot with no
    // configuration at all, because its readiness report came back clean.
    const broken = { APP_ENV: "staging", DATABASE_URL: "postgres://u:p@h/d" };
    const api = checkReadiness(broken, "staging", { consumer: "api" });
    expect(api.ok).toBe(false);
    expect(api.errors.map((e) => e.variable)).toContain("NEON_AUTH_JWKS_URL");
    // The Next.js-only variable is reported, but not as the API's failure.
    expect(api.warnings.map((w) => w.variable)).toContain("REVIEW_API_URL");
    expect(api.errors.map((e) => e.variable)).not.toContain("REVIEW_API_URL");

    const web = checkReadiness(broken, "staging", { consumer: "web" });
    expect(web.ok).toBe(false);
    expect(web.errors.map((e) => e.variable)).toContain("REVIEW_API_URL");
    expect(web.errors.map((e) => e.variable)).not.toContain("NEON_AUTH_JWKS_URL");
  });
});

describe("checkReadiness — local is allowed to be incomplete", () => {
  it("warns about what will answer 503 instead of failing", () => {
    const report = checkReadiness(
      {
        APP_ENV: "local",
        DATABASE_URL: "postgres://u:p@127.0.0.1:54329/concierge_local",
        LLM_PRIMARY_MODEL: "gemini-2.5-flash",
        LLM_FALLBACK_MODEL: "gemini-2.5-flash-lite",
        EMAIL_FROM: "Concierge <desk@example.com>",
      },
      "local",
    );
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.map((w) => w.variable)).toContain("GUEST_COOKIE_SECRET");
  });

  it("still fails locally on something with no default at all", () => {
    // Pinned model ids are required in every environment: there is nothing to fall
    // back to, and a floating alias is the thing DEC-2 exists to prevent.
    const report = checkReadiness({ APP_ENV: "local", DATABASE_URL: "postgres://u:p@h/d" }, "local");
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.variable)).toContain("LLM_PRIMARY_MODEL");
  });
});

describe("secrets never reach the report", () => {
  it("shows a secret as `set` and a plain value as itself", () => {
    const secret = VARIABLES.find((v) => v.name === "LLM_API_KEY")!;
    const plain = VARIABLES.find((v) => v.name === "GUEST_PUBLIC_URL")!;
    expect(maskSecret(secret, "sk-live-abcdefgh")).toBe("set");
    expect(maskSecret(plain, "https://chat.example.com")).toBe("https://chat.example.com");
  });

  it("scrubs a secret a loader interpolated into its own error message", () => {
    const key = "sk-ant-super-secret-value-0123456789";
    const message = `provider rejected the key ${key} for this deployment`;
    expect(scrubSecrets(message, { LLM_API_KEY: key })).toBe(
      "provider rejected the key [redacted] for this deployment",
    );
  });

  it("does not scrub a two-character value into ordinary words", () => {
    expect(scrubSecrets("the on switch is on", { LLM_API_KEY: "on" })).toBe("the on switch is on");
  });

  it("the serialized report contains no secret value", () => {
    const report = checkReadiness({ ...STAGING, LLM_API_KEY: "sk-ant-very-secret-0123456789" }, "staging");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("sk-ant-very-secret-0123456789");
    expect(serialized).not.toContain("0123456789abcdef0123456789abcdef");
    expect(serialized).not.toContain("re_testkeyvalue1234567890");
  });
});

describe("the manifest itself", () => {
  it("requires nothing of prod that it does not also require of staging", () => {
    // Prod being stricter than staging is how a deploy passes every rehearsal and
    // fails on the night. Being *looser* is fine; expecting more is not.
    const staging = new Set(requirementsFor("staging").required.map((v) => v.name));
    const prod = requirementsFor("prod").required.map((v) => v.name);
    for (const name of prod) expect(staging.has(name), name).toBe(true);
  });

  it("documents every variable in .env.example", () => {
    // The template is what a new environment is built from. A variable that exists
    // in the contract but not the template is a required value nobody knows to set;
    // this test fails the build on that drift instead of on the deploy.
    const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const undocumented = VARIABLES.filter(
      (variable) => !new RegExp(`(^|#\\s*)${variable.name}=`, "m").test(example),
    ).map((variable) => variable.name);
    expect(undocumented).toEqual([]);
  });

  it("documents NO variable the code has forgotten", () => {
    // The other direction, and the one that actually bites: the template kept
    // STAGING_DATABASE_URL / PROD_DATABASE_URL / LOCAL_DATABASE_URL long after the
    // manifest dropped them. Someone copying the template then fills in values
    // nothing reads, and the deploy fails on an empty DATABASE_URL while the file
    // looks complete. Stale documentation is worse than missing documentation.
    const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const documented = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    // Placeholders in prose (`<from the dashboard>`) are not assignments; the regex
    // above only matches NAME=, so those are already excluded.
    const known = new Set(VARIABLES.map((variable) => variable.name));
    const stale = [...new Set(documented)].filter((name) => !known.has(name));
    expect(stale).toEqual([]);
  });

  it("names no variable after its environment", () => {
    // The owner's rule, enforced where it is cheap: the template is the first place
    // a suffixed name would reappear.
    const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const suffixed = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined)
      .filter((name) => /^(STAGING|PROD|PRODUCTION)_|_(STAGING|PROD|PRODUCTION)$/.test(name));
    expect(suffixed).toEqual([]);
  });

  it("marks every secret as a secret in every consumer", () => {
    // A database URL, a provider key and a cookie secret are the four things whose
    // appearance in a CI log is a real incident.
    for (const name of ["DATABASE_URL", "LLM_API_KEY", "GUEST_COOKIE_SECRET", "VERCEL_TOKEN"]) {
      expect(VARIABLES.find((v) => v.name === name)?.secret, name).toBe(true);
    }
  });
});
