import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE, STAGES, VARIABLES } from "./manifest.ts";

/**
 * The coverage guard - the test whose absence let `GEMINI_API_KEY` exist.
 *
 * `GEMINI_API_KEY` was gated in `scripts/eval.ts` and `.github/workflows/eval.yml`
 * (S06-03, Oct 25) two days BEFORE the contract was written (W00-13, Oct 27). The
 * contract was derived from the loaders, nobody scanned the other direction, and no
 * test connects a name the code gates on to a name the contract declares. The eval
 * canary checked a variable nothing consumed, the loader it actually calls reads
 * `LLM_API_KEY`, and the run died one step later on missing model ids anyway.
 *
 * This file closes that hole from both sides:
 *
 *  - **code -> contract**: every env name read in `src/`, `scripts/`, `api/`, `web/`
 *    and every `secrets.X` / `vars.X` a workflow references must be declared in
 *    `CORE`, and the workflow's prefix must agree with the declared type
 *    (`secrets.` <=> `secret: true`, `vars.` <=> `secret: false`).
 *  - **contract -> code**: every non-planned `CORE` name must be read somewhere, so
 *    the contract cannot document variables nothing consumes (the mirror drift the
 *    `.env.example` tests already catch between template and contract).
 *
 * Test files are deliberately excluded from the code scan: fixtures are not gates.
 * A platform variable that is genuinely not part of this contract belongs in
 * `PLATFORM_NAMES` below with a reason, not in a silent exception.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Names supplied by a hosting platform, read by nothing here - not contract material.
 *
 * `GITHUB_SHA` - injected by Actions into every job, read by `scripts/eval.ts`
 * only to stamp the run provenance with the commit it scored. It is not a value
 * anyone configures per environment, and declaring it in `CORE` would be a lie
 * the `secrets:`/`vars:` direction of this test could not even express: no
 * workflow references it, because the runner supplies it.
 */
const PLATFORM_NAMES = new Set<string>(["GITHUB_SHA"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", "dist", "coverage", ".git", ".vercel"].includes(entry)) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const CODE_ROOTS = ["src", "scripts", "api", "web"].map((name) => join(ROOT, name));

const CODE_PATTERNS: RegExp[] = [
  // process.env.NAME / process.env["NAME"] - the platform-injected form.
  /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])/g,
  // source["NAME"] - this repo's loader convention: every config loader takes a
  // `source: Record<string, string | undefined>` and reads uppercase names from it.
  /\bsource\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
];

interface Read {
  name: string;
  file: string;
}

function codeReads(): Read[] {
  const reads: Read[] = [];
  for (const root of CODE_ROOTS) {
    for (const file of walk(root)) {
      if (!/\.(ts|tsx)$/.test(file) || file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const pattern of CODE_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const name = match[1] ?? match[2];
          if (name !== undefined) reads.push({ name, file: file.slice(ROOT.length + 1) });
        }
      }
    }
  }
  return reads;
}

interface WorkflowRead {
  name: string;
  kind: "secrets" | "vars";
  file: string;
}

function workflowReads(): WorkflowRead[] {
  const dir = join(ROOT, ".github", "workflows");
  const reads: WorkflowRead[] = [];
  for (const file of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const match of text.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Z0-9_]+)\s*\}\}/g)) {
      reads.push({ kind: match[1] as "secrets" | "vars", name: match[2]!, file });
    }
  }
  return reads;
}

const coreByName = new Map(CORE.map((variable) => [variable.name, variable]));

// Walked once per run: the three tests below ask different questions of the same
// scan, and re-reading every file per test made this suite the slowest in the
// repo - close enough to the default 5s timeout to flake on a loaded machine.
const CODE_READS: Read[] = codeReads();
const WORKFLOW_READS: WorkflowRead[] = workflowReads();

describe("contract coverage - code and workflows against CORE", () => {
  it("every environment name the code reads is declared in the contract", () => {
    // The GEMINI_API_KEY guard: a gate on a name the contract has never heard of
    // fails HERE, in the PR that introduces it, instead of as a red canary whose
    // error message names a variable no loader reads.
    const undeclared = [
      ...new Set(
        CODE_READS.filter(
          (read) => !PLATFORM_NAMES.has(read.name) && !coreByName.has(read.name),
        ).map((read) => `${read.name} (${read.file})`),
      ),
    ].sort();
    expect(undeclared).toEqual([]);
  });

  it("every secret or variable a workflow references is declared, with the matching type", () => {
    // A `vars.X` for a declared secret would publish it to anyone who can list
    // variables; a `secrets.X` for a declared non-secret hides that it could have
    // been a variable. Both happen by typo, and both are silent without this test.
    const wrong: string[] = [];
    for (const read of WORKFLOW_READS) {
      const core = coreByName.get(read.name);
      if (core === undefined) {
        wrong.push(`${read.file}: ${read.kind}.${read.name} is not in the contract`);
        continue;
      }
      const isSecret = read.kind === "secrets";
      if (core.secret !== isSecret) {
        wrong.push(
          `${read.file}: ${read.kind}.${read.name} but the contract declares ` +
            `secret: ${core.secret}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every non-planned contract variable is read by the code or a workflow", () => {
    // The other direction: the contract must not document names nothing consumes.
    // A variable that is declared, documented, synced - and read nowhere - is
    // scaffolding that outlives its reason. SENTRY_DSN is the documented exception:
    // planned, because W00-14 has no reporter wired yet.
    const readNames = new Set([
      ...CODE_READS.map((read) => read.name),
      ...WORKFLOW_READS.map((read) => read.name),
    ]);
    const unread = VARIABLES.filter(
      (variable) => !variable.planned && !readNames.has(variable.name),
    ).map((variable) => variable.name);
    expect(unread).toEqual([]);
  });
});

describe("contract coverage - stage sub-contracts against CORE", () => {
  const stageNames = Object.entries(STAGES);

  it("every stage names only variables CORE declares", () => {
    // Validated at module load too; this test states it as a contract property with
    // a failure that names the stage instead of an import-time stack.
    for (const [env, stage] of stageNames) {
      for (const name of [...stage.required, ...stage.recommended]) {
        expect(coreByName.has(name), `${env} names "${name}", which CORE does not declare`).toBe(
          true,
        );
      }
    }
  });

  it("no stage lists one variable twice, or both required and recommended", () => {
    for (const [env, stage] of stageNames) {
      expect(new Set(stage.required).size, `${env}.required has a duplicate`).toBe(
        stage.required.length,
      );
      expect(new Set(stage.recommended).size, `${env}.recommended has a duplicate`).toBe(
        stage.recommended.length,
      );
      const both = stage.recommended.filter((name) => stage.required.includes(name));
      expect(both, `${env} lists as both`).toEqual([]);
    }
  });

  it("no stage requires a planned variable", () => {
    // planned means "documented, not enforced" - a stage that requires it would
    // fail a deploy over a feature that does not exist.
    for (const [env, stage] of stageNames) {
      for (const name of stage.required) {
        expect(coreByName.get(name)?.planned, `${env}.required includes ${name}`).not.toBe(true);
      }
    }
  });

  it("prod requires exactly what staging requires - no stricter, no looser", () => {
    // Prod being stricter is how a deploy passes every rehearsal and fails on the
    // night; prod being looser means staging proved nothing about production.
    expect([...STAGES.prod.required].sort()).toEqual([...STAGES.staging.required].sort());
    expect([...STAGES.prod.recommended].sort()).toEqual([...STAGES.staging.recommended].sort());
  });
});

describe("contract coverage - the Vercel surface serves what smoke probes", () => {
  // smoke.ts probes these paths on ${API_URL} on EVERY run; the deploy job's
  // smoke step is the last gate before a deployment is called green. The
  // Vercel-hosted surface is only api/** (bundled into the Build Output API by
  // scripts/build-vercel.ts), so a probe path with no file behind it 404s -
  // which is exactly how the first staging rehearsal failed: /healthz existed
  // on the long-running host and nowhere else. This test makes that mismatch
  // a PR-time failure.
  const ALWAYS_PROBED = ["/healthz", "/healthz/postgres"];
  // Only probed with --write (never in deploy.yml): posting a synthetic guest
  // turn. Ported with the rest of the chat surface in #153's Option A.
  const WRITE_ONLY_PROBED = ["/api/chat/messages"];

  const vercelJson = JSON.parse(
    readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
  ) as { routes?: { src?: string; dest?: string }[] };
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: { build?: string } };

  it("extracts the probe list from smoke.ts (so the guard tracks the script)", () => {
    const smoke = readFileSync(new URL("../../scripts/smoke.ts", import.meta.url), "utf8");
    const probed = [...smoke.matchAll(/\$\{target\.url\}(\/[a-zA-Z0-9/_-]*)/g)].map(
      (m) => m[1]!,
    );
    for (const path of ALWAYS_PROBED.concat(WRITE_ONLY_PROBED)) {
      expect(probed, `smoke.ts no longer probes ${path} - update this guard`).toContain(path);
    }
  });

  it("bundles every always-probed path: a file exists behind the route", () => {
    // The build script is what puts api/** into the deployment, so the first
    // assertion keeps `npm run build` wired to it - a green tsc alone deploys
    // nothing. The rest: every probe route must dest to an existing api entry
    // on the api surface (a dest outside api/ would be the monolith returning),
    // which scripts/build-vercel.ts then bundles at that exact path.
    expect(packageJson.scripts?.build ?? "").toContain("build-vercel.ts");
    for (const path of ALWAYS_PROBED) {
      const route = (vercelJson.routes ?? []).find((r) => r.src === path);
      expect(route, `vercel.json has no route for ${path} - smoke will 404`).toBeDefined();
      expect(
        route!.dest!.startsWith("/api/"),
        `route ${path} dests to ${route!.dest} - outside the api surface`,
      ).toBe(true);
      // Route dests are extensionless (the function dir name); the source file
      // behind them carries the .ts the bundler consumed.
      const file = join(ROOT, route!.dest!.replace(/^\//, "") + ".ts");
      expect(
        statSync(file, { throwIfNoEntry: false })?.isFile(),
        `route ${path} -> ${route!.dest} has no file behind it`,
      ).toBe(true);
    }
  });

  it("routes appear before the filesystem handle, most specific first", () => {
    const routes = vercelJson.routes ?? [];
    const handleIndex = routes.findIndex((r) => (r as { handle?: string }).handle !== undefined);
    expect(handleIndex, "no { handle: 'filesystem' } - /api/** would stop serving").toBeGreaterThan(
      -1,
    );
    for (const path of ALWAYS_PROBED) {
      const i = routes.findIndex((r) => r.src === path);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(handleIndex);
    }
    // /healthz must not shadow /healthz/postgres.
    const healthz = routes.findIndex((r) => r.src === "/healthz");
    const pg = routes.findIndex((r) => r.src === "/healthz/postgres");
    expect(pg).toBeLessThan(healthz);
  });
});
