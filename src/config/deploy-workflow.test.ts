import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VARIABLES } from "./manifest.ts";

/**
 * The deploy workflow is the one file that can silently undo the whole naming rule.
 *
 * A single `secrets.PROD_LLM_API_KEY` in it would not fail any test — it would fail
 * at 3 a.m. with an empty string, on the production deploy, after the migration had
 * already run. So the workflow is checked against the manifest the same way the code
 * is: same names, same secret-ness, same set in both jobs.
 */
const WORKFLOW = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
const PACKAGE = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

const names = (pattern: RegExp): string[] =>
  [...WORKFLOW.matchAll(pattern)].map((match) => match[1]).filter((name): name is string => name !== undefined);

const secretsUsed = [...new Set(names(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g))].sort();
const varsUsed = [...new Set(names(/\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}/g))].sort();

/** The text of one job, from its key to the next job key at the same indent. */
function job(name: string): string {
  const jobs = WORKFLOW.slice(WORKFLOW.indexOf("\njobs:"));
  const start = jobs.indexOf(`\n  ${name}:`);
  expect(start, `job ${name} exists`).toBeGreaterThan(-1);
  const rest = jobs.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("the deploy workflow obeys the manifest", () => {
  it("never names a variable after its environment", () => {
    // The pattern the owner rejected: TOKEN_PRODUCTION / STAGING_TOKEN / PROD_TOKEN.
    const offenders = [...secretsUsed, ...varsUsed].filter((name) =>
      /^(STAGING|PROD|PRODUCTION)_|_(STAGING|PROD|PRODUCTION)$/.test(name),
    );
    expect(offenders).toEqual([]);
  });

  it("reads every secret through `secrets.` and every non-secret through `vars.`", () => {
    // A secret in `vars.` is world-readable to anyone who can list variables. A
    // non-secret in `secrets.` is harmless but hides that it could have been a
    // variable, and it makes `check:readiness` unable to verify it.
    for (const name of secretsUsed) {
      const variable = VARIABLES.find((entry) => entry.name === name);
      expect(variable, `${name} is in the manifest`).toBeDefined();
      expect(variable!.secret, `${name} is declared secret`).toBe(true);
    }
    for (const name of varsUsed) {
      const variable = VARIABLES.find((entry) => entry.name === name);
      expect(variable, `${name} is in the manifest`).toBeDefined();
      expect(variable!.secret, `${name} is declared NOT secret`).toBe(false);
    }
  });

  it("gives staging and production the identical set of names", () => {
    // The core of the design: `environment:` is the only difference. If these two
    // lists drift, one job is reading a value the other never sets — and the drift is
    // invisible until a deploy.
    // `names` reads the whole file, so scan each job's text directly.
    const perJob = (text: string) =>
      [
        ...new Set(
          [...text.matchAll(/\$\{\{\s*(?:secrets|vars)\.([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]),
        ),
      ]
        .filter((name): name is string => name !== undefined)
        .sort();
    expect(perJob(job("production"))).toEqual(perJob(job("staging")));
  });

  it("binds each job to the GitHub Environment its values come from", () => {
    expect(job("staging")).toMatch(/environment:\s*staging\s*\n/);
    expect(job("production")).toMatch(/environment:\s*production\s*\n/);
  });

  it("does not try to read the other environment's secrets", () => {
    // A job bound to one environment physically cannot see the other's secrets, so
    // any cross-environment check here would pass silently by comparing two empty
    // strings. The hashed cluster fingerprint in the smoke step is the real proof.
    expect(WORKFLOW).not.toMatch(/run:[^\n]*npm run check:env\b/);
  });

  it("migrates before it deploys", () => {
    const index = (needle: string) => WORKFLOW.indexOf(needle);
    for (const env of ["staging", "production"]) {
      const body = job(env);
      expect(body.indexOf("db:migrate"), `${env}: migrate exists`).toBeGreaterThan(-1);
      expect(body.indexOf("db:migrate"), `${env}: migrate precedes deploy`).toBeLessThan(
        body.indexOf("vercel@latest deploy"),
      );
    }
    void index;
  });

  it("only calls scripts that exist", () => {
    const called = [...new Set(names(/npm run ([\w:-]+)/g))];
    expect(called.length).toBeGreaterThan(0);
    for (const script of called) {
      expect(PACKAGE.scripts, `npm run ${script}`).toHaveProperty([script]);
    }
  });

  it("never prints a secret into the log", () => {
    // `echo "$LLM_API_KEY"` or `echo "${{ secrets.DATABASE_URL }}"` would publish the
    // value in a build log that outlives the rotation.
    expect(WORKFLOW).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
    expect(WORKFLOW).not.toMatch(/echo[^\n]*\$\{?(DATABASE_URL|LLM_API_KEY|GUEST_COOKIE_SECRET|EMAIL_API_KEY|TURNSTILE_SECRET|EMBEDDING_API_KEY)\b(?!\s*:\s*0)/);
  });

  it("says out loud when smoke could not run", () => {
    // An absent API_URL must look like a skip, in the log and in the job summary —
    // never like a green smoke test that probed nothing.
    expect(WORKFLOW.match(/::warning::/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(WORKFLOW.match(/\$\{\{ vars\.API_URL \}\}/g)?.length ?? 0).toBe(2);
  });
});
