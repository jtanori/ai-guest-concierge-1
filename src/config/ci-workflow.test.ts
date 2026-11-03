import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The CI workflow must validate commits, not deploy them.
 *
 * Vercel's Git integration builds every pushed branch and owns those
 * deployments: `main` becomes Production, a PR branch becomes a Preview, and a
 * `staging` branch serves the staging domain. A `vercel deploy` in GitHub
 * Actions is therefore a SECOND deployer for the same commit — two builders,
 * one SHA, and a preview URL that may not belong to the commit under review.
 *
 * This file is the guard that keeps CI a validator. It fails the PR that
 * reintroduces a deploy command, before that PR can race the native build.
 *
 * `deploy-workflow.test.ts` covers the deploy workflow separately, because
 * that one still owns migrations and smoke and is allowed to deploy.
 */
const CI_RAW = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

/**
 * The workflow with comments removed.
 *
 * The assertions below are about what the workflow DOES, and a comment that
 * explains why it no longer deploys necessarily names the thing it forbids
 * (`vercel deploy`, `--prebuilt`). Matching against commented text would fail
 * every PR that documents the migration, so comments are stripped first and
 * only executable lines are judged.
 */
const CI = CI_RAW.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("ci.yml validates commits instead of deploying them", () => {
  it("never runs a Vercel deploy command", () => {
    // The whole point of this file. `vercel deploy` anywhere in CI recreates the
    // two-deployer race this migration exists to remove.
    const offenders = CI.split("\n").filter((line) =>
      /npx\s+.*vercel@[\w.-]+\s+deploy|\bvercel\s+deploy\b/.test(line),
    );
    expect(offenders, "ci.yml must not create Vercel deployments").toEqual([]);
  });

  it("never pins an alias", () => {
    // Alias pinning is how a deployment steals a domain it was not assigned.
    // Vercel's branch/domain binding owns that decision now.
    expect(CI).not.toMatch(/\/aliases\?teamId=/);
    expect(CI).not.toMatch(/vercel\s+alias\s+set/);
  });

  it("reads the native preview instead of creating one", () => {
    // The preview job looks the native deployment up by commit SHA and probes
    // it. Both halves must exist: a lookup with no probe is an unverified
    // claim, a probe with no lookup has nothing to probe.
    expect(CI, "lookup step missing").toMatch(
      /Wait for Vercel's native preview of this commit/,
    );
    expect(CI, "probe step missing").toMatch(/Probe preview \/api\/health\.ts/);
    expect(CI, "lookup must select by the commit under review").toMatch(
      /githubCommitSha/,
    );
    expect(CI).toMatch(/github\.event\.pull_request\.head\.sha/);
  });

  it("fails when the native preview never becomes READY", () => {
    // A preview that never appears must be a red check. If the wait loop could
    // fall through green with an empty URL, a missing deployment would read as
    // a healthy one — the exact false pass this job exists to prevent.
    expect(CI).toMatch(/No READY native preview for/);
    expect(CI).toMatch(/exit 1/);
    // READY is the only state allowed to break the wait loop.
    expect(CI).toMatch(/\[ "\$STATE" = "READY" \]/);
  });

  it("keeps the token read-only: it never uploads Build Output", () => {
    // The job still runs `npm run build` so a broken bundler fails in CI, but
    // nothing in this workflow ships that output. `--prebuilt` was the flag
    // that shipped it; its absence is the assertion.
    expect(CI).not.toMatch(/--prebuilt/);
    expect(CI).not.toMatch(/vercel@latest deploy/);
  });

  it("skips fork PRs, which have neither secrets nor a native deployment", () => {
    // gitForkProtection is on and GitHub withholds repo secrets from forks, so
    // a fork run could not read a preview even if one existed. Skipping keeps
    // `preview` out of the required contexts' way without faking a pass.
    expect(CI).toMatch(
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
  });

  it("keeps every Vercel reference the contract already declares", () => {
    // contract-coverage.test.ts checks the type of each of these against the
    // manifest. Asserting the set here catches a rename in one direction before
    // that test reports it as an undeclared name.
    const referenced = [...new Set([...CI.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Z0-9_]+)\s*\}\}/g)].map((m) => `${m[1]}.${m[2]}`))].sort();
    expect(referenced).toEqual([
      "secrets.VERCEL_TOKEN",
      "vars.VERCEL_ORG_ID",
      "vars.VERCEL_PROJECT_ID",
    ]);
  });

  it("retains the CI gates the merge depends on", () => {
    // The migration removes deployment from CI, never validation. If a later
    // edit drops a gate while simplifying the deploy path, it fails here.
    for (const job of ["lint:", "typecheck:", "test:", "env-check:", "db-test:", "web-build:", "preview:"]) {
      expect(CI, `ci.yml lost the ${job} job`).toMatch(new RegExp(`\\n  ${job.replace(":", ":")}`));
    }
  });
});
