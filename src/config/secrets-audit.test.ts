import { describe, expect, it } from "vitest";
import { auditSecrets, vercelTargetFor } from "./secrets-audit.ts";
import type { RemoteState } from "./secrets-sync.ts";

/**
 * W00-13 — "the value is where the pipeline will look for it".
 *
 * The failure this guards against is not a typo in a name; it is a deploy that runs
 * with a variable the repository never had. The four states matter: a store that
 * could not be read must never be reported as a store that is complete.
 */
const remote = (overrides: Partial<NonNullable<RemoteState["github"]>> = {}): RemoteState => ({
  github: {
    repoSecrets: new Set<string>(),
    repoVariables: new Map<string, string>(),
    envSecrets: new Set<string>(),
    envVariables: new Map<string, string>(),
    environmentExists: true,
    ...overrides,
  },
  vercel: { target: "preview", entries: new Map<string, string | null>() },
});

const unreadable: RemoteState = { github: null, vercel: null };

describe("auditSecrets", () => {
  it("maps an environment to the Vercel target it actually deploys to", () => {
    expect(vercelTargetFor("staging")).toBe("preview");
    expect(vercelTargetFor("prod")).toBe("production");
    expect(vercelTargetFor("local")).toBe("preview");
  });

  it("finds a secret on the GitHub Environment, not the repository", () => {
    // The whole point of environments: `LLM_API_KEY` is an environment secret, so a
    // repo-level one with that name satisfies nothing.
    const repoLevelOnly = auditSecrets(
      "staging",
      remote({ repoSecrets: new Set(["LLM_API_KEY"]) }),
    );
    expect(repoLevelOnly.rows.find((r) => r.name === "LLM_API_KEY")!.status).toBe("missing");

    const environmentLevel = auditSecrets(
      "staging",
      remote({ envSecrets: new Set(["LLM_API_KEY"]) }),
    );
    expect(environmentLevel.rows.find((r) => r.name === "LLM_API_KEY")!.status).toBe("present");
  });

  it("distinguishes a secret from a variable of the same name", () => {
    // Storing LLM_API_KEY as a plain Actions variable would make it readable by any
    // workflow that can list variables — the audit must not accept that as present.
    const asVariable = auditSecrets(
      "staging",
      remote({ envVariables: new Map([["LLM_API_KEY", "sk-leaked"]]) }),
    );
    expect(asVariable.rows.find((r) => r.name === "LLM_API_KEY")!.status).toBe("missing");
  });

  it("reports a missing required value and fails", () => {
    const result = auditSecrets("staging", remote());
    expect(result.missing).toContain("LLM_API_KEY");
    expect(result.ok).toBe(false);
  });

  it("never reports an unreadable store as complete", () => {
    const result = auditSecrets("staging", unreadable);
    expect(result.unknown.length).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
  });

  it("checks Vercel variables against the right target", () => {
    const stagingHasIt: RemoteState = {
      github: remote().github,
      vercel: { target: "preview", entries: new Map([["REVIEW_API_URL", "https://api.staging"]]) },
    };
    expect(
      auditSecrets("staging", stagingHasIt).rows.find((r) => r.name === "REVIEW_API_URL")!.status,
    ).toBe("present");

    // A state read for `preview` cannot answer for `production`: it is unknown, not
    // present and not missing. The real reader filters by target, and this proves the
    // audit would not accept a preview-only variable as a production fact.
    expect(
      auditSecrets("prod", stagingHasIt).rows.find((r) => r.name === "REVIEW_API_URL")!.status,
    ).toBe("unknown");

    // With correctly-scoped state, the absence is a real gap.
    const prodState: RemoteState = {
      github: remote().github,
      vercel: { target: "production", entries: new Map() },
    };
    expect(
      auditSecrets("prod", prodState).rows.find((r) => r.name === "REVIEW_API_URL")!.status,
    ).toBe("missing");
  });

  it("accepts either half of an either/or pair", () => {
    const result = auditSecrets(
      "staging",
      remote({ envVariables: new Map([["NEON_AUTH_ISSUER", "https://auth"]]) }),
    );
    for (const name of ["NEON_AUTH_ISSUER", "NEON_AUTH_BASE_URL"]) {
      expect(result.rows.find((r) => r.name === name)!.status, name).toBe("present");
    }
  });

  it("reports the pair as one gap when neither half is set", () => {
    const result = auditSecrets("staging", remote());
    const pair = result.rows.filter((r) =>
      ["NEON_AUTH_ISSUER", "NEON_AUTH_BASE_URL"].includes(r.name),
    );
    expect(pair.filter((r) => r.status === "missing")).toHaveLength(1);
  });

  it("does not invent a gap from a store it could not read", () => {
    const result = auditSecrets("staging", unreadable);
    expect(result.missing).toEqual([]);
    expect(result.unknown.length).toBeGreaterThan(0);
  });

  it("treats a runtime-supplied value as not applicable, or checks the local file", () => {
    const withoutFile = auditSecrets("staging", remote());
    expect(withoutFile.rows.find((r) => r.name === "APP_ENV")!.status).toBe("not-applicable");

    const withFile = auditSecrets("staging", remote(), new Set(["APP_ENV"]));
    expect(withFile.rows.find((r) => r.name === "APP_ENV")!.status).toBe("present");
  });

  it("leaves planned variables out of the audit entirely", () => {
    // SENTRY_DSN is documented but W00-14 has not wired a reporter; demanding it
    // would fail a deploy over a feature that does not exist.
    const result = auditSecrets("staging", remote());
    expect(result.rows.map((r) => r.name)).not.toContain("SENTRY_DSN");
  });
});
