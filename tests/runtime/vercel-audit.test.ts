import { describe, expect, it } from "vitest";
import {
  auditVercelRuntime,
  REQUIRED_API_RUNTIME_VARS,
  type VercelEnvMetadata,
} from "../../scripts/check-vercel-runtime.ts";

describe("auditVercelRuntime", () => {
  const completePreviewEnvs: VercelEnvMetadata[] = [
    ...REQUIRED_API_RUNTIME_VARS.map((key) => ({
      key,
      target: ["preview"],
      gitBranch: null,
    })),
    {
      key: "NEON_AUTH_BASE_URL",
      target: ["preview"],
      gitBranch: null,
    },
    {
      key: "EMBEDDING_API_KEY",
      target: ["preview"],
      gitBranch: null,
    },
  ];

  it("passes when all required runtime variables are present for preview target", () => {
    const res = auditVercelRuntime("staging", "prj_test", completePreviewEnvs);
    expect(res.ok).toBe(true);
    expect(res.missing).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });

  it("fails closed when a critical runtime variable (like DATABASE_URL) is missing", () => {
    const incomplete = completePreviewEnvs.filter((e) => e.key !== "DATABASE_URL");
    const res = auditVercelRuntime("staging", "prj_test", incomplete);
    expect(res.ok).toBe(false);
    expect(res.missing).toContain("DATABASE_URL");
  });

  it("satisfies auth issuer with NEON_AUTH_ISSUER instead of NEON_AUTH_BASE_URL", () => {
    const withIssuer = completePreviewEnvs
      .filter((e) => e.key !== "NEON_AUTH_BASE_URL")
      .concat({
        key: "NEON_AUTH_ISSUER",
        target: ["preview"],
        gitBranch: null,
      });
    const res = auditVercelRuntime("staging", "prj_test", withIssuer);
    expect(res.ok).toBe(true);
    expect(res.missing).toHaveLength(0);
  });

  it("fails if both members of the auth issuer group are absent", () => {
    const withoutAuth = completePreviewEnvs.filter(
      (e) => e.key !== "NEON_AUTH_BASE_URL" && e.key !== "NEON_AUTH_ISSUER",
    );
    const res = auditVercelRuntime("staging", "prj_test", withoutAuth);
    expect(res.ok).toBe(false);
    expect(res.missing).toContain("oneOf(NEON_AUTH_ISSUER | NEON_AUTH_BASE_URL)");
  });

  it("emits a warning if optional EMBEDDING_API_KEY is absent", () => {
    const withoutEmbedding = completePreviewEnvs.filter((e) => e.key !== "EMBEDDING_API_KEY");
    const res = auditVercelRuntime("staging", "prj_test", withoutEmbedding);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.includes("EMBEDDING_API_KEY"))).toBe(true);
  });

  it("respects gitBranch bindings for preview deployments", () => {
    const branchSpecific: VercelEnvMetadata[] = [
      ...REQUIRED_API_RUNTIME_VARS.map((key) => ({
        key,
        target: ["preview"],
        gitBranch: "staging",
      })),
      {
        key: "NEON_AUTH_BASE_URL",
        target: ["preview"],
        gitBranch: "staging",
      },
    ];
    const res = auditVercelRuntime("staging", "prj_test", branchSpecific);
    expect(res.ok).toBe(true);

    // If variables were bound only to a different branch (e.g. 'dev'), staging should report them missing
    const differentBranch: VercelEnvMetadata[] = [
      ...REQUIRED_API_RUNTIME_VARS.map((key) => ({
        key,
        target: ["preview"],
        gitBranch: "feature-branch",
      })),
      {
        key: "NEON_AUTH_BASE_URL",
        target: ["preview"],
        gitBranch: "feature-branch",
      },
    ];
    const failRes = auditVercelRuntime("staging", "prj_test", differentBranch);
    expect(failRes.ok).toBe(false);
    expect(failRes.missing.length).toBeGreaterThan(0);
  });

  it("checks production target scope when env is prod", () => {
    const prodEnvs: VercelEnvMetadata[] = [
      ...REQUIRED_API_RUNTIME_VARS.map((key) => ({
        key,
        target: ["production"],
        gitBranch: null,
      })),
      {
        key: "NEON_AUTH_BASE_URL",
        target: ["production"],
        gitBranch: null,
      },
    ];
    const res = auditVercelRuntime("prod", "prj_test", prodEnvs);
    expect(res.ok).toBe(true);
    expect(res.missing).toHaveLength(0);
  });
});
