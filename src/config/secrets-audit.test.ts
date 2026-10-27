import { describe, expect, it } from "vitest";
import { auditSecrets, vercelTargetFor, type Inventories } from "./secrets-audit.ts";

/**
 * W00-13 — "the value is where the pipeline will look for it".
 *
 * The failure this guards against is not a typo in a name; it is a deploy that runs
 * with a variable the repository never had. The three states matter: a store that
 * could not be read must never be reported as a store that is complete.
 */
const inventories = (overrides: Partial<Inventories> = {}): Inventories => ({
  github: new Set<string>(),
  vercel: new Map([
    ["preview", new Set<string>()],
    ["production", new Set<string>()],
  ]),
  local: null,
  ...overrides,
});

describe("auditSecrets", () => {
  it("maps an environment to the Vercel target it actually deploys to", () => {
    expect(vercelTargetFor("staging")).toBe("preview");
    expect(vercelTargetFor("prod")).toBe("production");
    expect(vercelTargetFor("local")).toBe("preview");
  });

  it("reports a present repository secret as present", () => {
    const result = auditSecrets(
      "staging",
      inventories({ github: new Set(["LLM_API_KEY", "GUEST_COOKIE_SECRET"]) }),
    );
    const row = result.rows.find((entry) => entry.name === "LLM_API_KEY")!;
    expect(row.status).toBe("present");
    expect(row.home).toBe("github-secret");
  });

  it("reports a missing repository secret as missing, and fails", () => {
    const result = auditSecrets("staging", inventories({ github: new Set<string>() }));
    expect(result.missing).toContain("LLM_API_KEY");
    expect(result.ok).toBe(false);
  });

  it("never reports an unreadable store as complete", () => {
    // The whole reason this module returns three states: a check that goes green
    // because it could not look is worse than no check.
    const result = auditSecrets("staging", inventories({ github: null }));
    expect(result.unknown).toContain("LLM_API_KEY");
    expect(result.missing).not.toContain("LLM_API_KEY");
    expect(result.ok).toBe(false);
  });

  it("checks Vercel variables against the right target", () => {
    const previewOnly = inventories({
      vercel: new Map([
        ["preview", new Set(["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "REVIEW_API_URL"])],
        ["production", new Set<string>()],
      ]),
    });
    expect(
      auditSecrets("staging", previewOnly).rows.find(
        (row) => row.name === "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      )!.status,
    ).toBe("present");

    // The same variable absent from `production` is a prod gap, not a staging one.
    expect(
      auditSecrets("prod", previewOnly).rows.find(
        (row) => row.name === "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      )!.status,
    ).toBe("missing");
  });

  it("accepts either half of an either/or pair", () => {
    // With no local inventory, both halves are platform-supplied and invisible here;
    // that is "cannot tell", never "missing".
    const withIssuer = auditSecrets("staging", inventories({ github: null }));
    const issuer = withIssuer.rows.find((row) => row.name === "NEON_AUTH_ISSUER")!;
    expect(issuer.status).toBe("not-applicable");
    expect(withIssuer.missing).not.toContain("NEON_AUTH_ISSUER");

    // With a local file that sets one of them, the pair is satisfied.
    const result = auditSecrets(
      "staging",
      inventories({ local: new Set(["NEON_AUTH_ISSUER"]) }),
    );
    for (const name of ["NEON_AUTH_ISSUER", "NEON_AUTH_BASE_URL"]) {
      expect(result.rows.find((row) => row.name === name)!.status, name).toBe("present");
    }
  });

  it("reports the pair as one gap when neither half is set", () => {
    const result = auditSecrets("staging", {
      github: null,
      vercel: null,
      local: new Set(["APP_ENV"]),
    });
    const pair = result.rows.filter((row) =>
      ["NEON_AUTH_ISSUER", "NEON_AUTH_BASE_URL"].includes(row.name),
    );
    expect(pair.filter((row) => row.status === "missing")).toHaveLength(1);
    expect(pair[0]!.detail).toMatch(/none of NEON_AUTH_ISSUER \| NEON_AUTH_BASE_URL is set/);
  });

  it("does not audit variables the manifest leaves to the platform", () => {
    const result = auditSecrets("staging", inventories({ github: null }));
    expect(result.rows.find((row) => row.name === "LLM_PRIMARY_MODEL")!.status).toBe(
      "not-applicable",
    );
  });

  it("leaves planned variables out of the audit entirely", () => {
    // SENTRY_DSN is documented but W00-14 has not wired a reporter; demanding it
    // would fail a deploy over a feature that does not exist.
    const result = auditSecrets("staging", inventories({ github: null }));
    expect(result.rows.map((row) => row.name)).not.toContain("SENTRY_DSN");
  });
});
