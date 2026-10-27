#!/usr/bin/env node
/**
 * W00-13 — `npm run secrets:sync`, one local file to every place that needs it.
 *
 *   npm run secrets:sync -- --env-file=.env.staging --env=staging
 *   npm run secrets:sync -- --env-file=.env.staging --env=staging --dry-run
 *   npm run secrets:sync -- --env-file=.env.production --env=prod --force
 *
 * Reads ONE file, decides which values belong in which store, and writes only what
 * is missing or different. Nothing is ever printed that could be a secret.
 *
 * ## Which store a value goes to is not decided here
 *
 * It is decided in `src/config/manifest.ts`, per variable (`store`). This script is
 * the executor: it does not contain a second opinion about where `LLM_API_KEY`
 * belongs, because two opinions is exactly how a secret ends up in the wrong account.
 *
 * ## What "only if changed" honestly means
 *
 *   - **GitHub variables** are read back and compared by value.
 *   - **GitHub secrets are write-only.** The API returns names, never values. So a
 *     secret that is already present is SKIPPED and reported as `skip-present` — not
 *     `skip-equal`, because no comparison happened. Rotating a key upstream and
 *     re-running therefore requires `--force`; that is the price of write-only
 *     storage, and it is cheaper than rewriting forty secrets every run and burning
 *     the only history GitHub keeps (`updated_at`).
 *   - **Vercel** returns values for plain variables and omits sensitive ones; the same
 *     rule applies, per variable.
 *
 * Exit codes: 0 synced (or nothing to do), 1 some write failed, 2 bad usage.
 */
import process from "node:process";
import { loadEnvFile, DotenvError } from "../src/config/dotenv.ts";
import { resolveCheckEnv } from "../src/config/preflight.ts";
import { githubEnvironmentFor } from "../src/config/manifest.ts";
import { planSync, writesOf, type SyncPlan } from "../src/config/secrets-sync.ts";
import {
  ensureGithubEnvironment,
  readGithubState,
  readVercelState,
  writeGithub,
  writeVercel,
} from "../src/config/remote-state.ts";

interface Args {
  env: string | undefined;
  file: string | null;
  dryRun: boolean;
  force: boolean;
  only: string[] | null;
  destinations: { github: boolean; vercel: boolean };
  json: boolean;
}

function usage(): string {
  return [
    "usage: secrets:sync --env local|staging|prod [--env-file .env.<env>] [options]",
    "",
    "  --env         which environment's stores to write (required)",
    "  --env-file    the source of truth (default: .env.<env>)",
    "  --dry-run     print the plan and write nothing",
    "  --force       rewrite secrets that are already present (values are write-only)",
    "  --only        comma-separated names to sync, e.g. --only=LLM_API_KEY,EMAIL_API_KEY",
    "  --no-github / --no-vercel   restrict destinations",
    "  --json        machine-readable plan",
    "",
    "where each value goes is decided by src/config/manifest.ts, not by this script",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  let env: string | undefined;
  let file: string | null = null;
  let dryRun = false;
  let force = false;
  let only: string[] | null = null;
  let github = true;
  let vercel = true;
  let json = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--no-github") {
      github = false;
      continue;
    }
    if (arg === "--no-vercel") {
      vercel = false;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    // `--env=staging` and `--env staging` must both work: the example in the
    // request used the first form, and a tool that only accepts one is a tool
    // somebody's copy-paste silently breaks.
    if (arg.startsWith("--") && arg.includes("=")) {
      const equals = arg.indexOf("=");
      const flag = arg.slice(2, equals);
      const value = arg.slice(equals + 1);
      if (flag === "env") env = value;
      else if (flag === "env-file") file = value;
      else if (flag === "only") only = value.split(",").map((n) => n.trim()).filter(Boolean);
      else throw new Error(`unknown option --${flag}\n\n${usage()}`);
      continue;
    }
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value\n\n${usage()}`);
      }
      if (arg === "--env") env = next;
      else if (arg === "--env-file") file = next;
      else if (arg === "--only") only = next.split(",").map((n) => n.trim()).filter(Boolean);
      else throw new Error(`unknown option ${arg}\n\n${usage()}`);
      index++;
      continue;
    }
    throw new Error(`unexpected argument "${arg}"\n\n${usage()}`);
  }

  if (env === undefined) throw new Error(`--env is required\n\n${usage()}`);
  return { env, file, dryRun, force, only, destinations: { github, vercel }, json };
}

const SYMBOL: Record<string, string> = {
  create: "+",
  update: "~",
  "skip-equal": "=",
  "skip-present": "·",
  "skip-absent-from-file": " ",
  runtime: " ",
  blocked: "?",
};

function render(plan: SyncPlan, applied: boolean): string {
  const lines: string[] = [];
  lines.push(`source: ${plan.env} · destination environment: ${githubEnvironmentFor(plan.env)}`);

  const shown = plan.rows.filter(
    (row) => row.action !== "runtime" && row.action !== "skip-absent-from-file",
  );
  if (shown.length === 0) {
    lines.push("nothing to do: no syncable value found in the file");
  } else {
    const width = Math.max(...shown.map((row) => row.name.length));
    lines.push("");
    for (const row of shown) {
      lines.push(
        `  ${SYMBOL[row.action]} ${row.name.padEnd(width)}  ${row.kind.padEnd(8)} ${row.target.padEnd(22)} ${row.action}`,
      );
      if (row.action === "skip-present" || row.action === "blocked" || row.action === "update") {
        lines.push(`      ${row.detail}`);
      }
    }
  }

  if (plan.absent.length > 0) {
    lines.push("", "required but absent from the file (the sync cannot invent these):");
    for (const name of plan.absent) lines.push(`  ✗ ${name}`);
  }

  lines.push(
    "",
    `${plan.counts.create} create · ${plan.counts.update} update · ` +
      `${plan.counts["skip-equal"]} unchanged · ${plan.counts["skip-present"]} present-unverified · ` +
      `${plan.counts.blocked} blocked`,
  );
  lines.push(applied ? `wrote ${plan.writes} value(s)` : `dry run — would write ${plan.writes} value(s)`);
  return lines.join("\n");
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  let env;
  try {
    env = resolveCheckEnv(args.env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const file = args.file ?? `.env.${env}`;
  let source: Record<string, string>;
  try {
    source = loadEnvFile(file).values;
  } catch (error) {
    const message = error instanceof DotenvError ? error.message : String(error);
    process.stderr.write(`secrets:sync: ${message}\n`);
    return 2;
  }

  // A file that declares the wrong environment is the single most damaging mistake
  // this tool could make: syncing `.env.staging` into the `production` environment
  // would overwrite production's keys with staging's. Refuse.
  const declared = source["APP_ENV"];
  if (declared !== undefined && declared !== env) {
    process.stderr.write(
      `secrets:sync: ${file} declares APP_ENV=${declared} but --env=${env}. ` +
        "Refusing to push one environment's values into another's stores.\n",
    );
    return 2;
  }

  const github = args.destinations.github ? readGithubState(env) : null;
  const vercel = args.destinations.vercel ? await readVercelState(env, source) : null;

  const plan = planSync(env, source, { github, vercel }, {
    force: args.force,
    ...(args.only === null ? {} : { only: args.only }),
  });

  // Any destination that could not be read makes the plan incomplete; say so instead
  // of printing a clean sheet built from missing information.
  if (args.destinations.github && github === null) {
    process.stderr.write(
      "secrets:sync: GitHub could not be read (`gh auth status`). Values targeting GitHub were not planned.\n",
    );
  }
  if (args.destinations.vercel && vercel === null) {
    process.stderr.write(
      "secrets:sync: Vercel could not be read (VERCEL_TOKEN / VERCEL_PROJECT_ID missing?). Values targeting Vercel were not planned.\n",
    );
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          env,
          applied: !args.dryRun,
          writes: plan.writes,
          counts: plan.counts,
          absent: plan.absent,
          // Names and actions only: this output ends up in CI logs and pasted issues.
          rows: plan.rows.map(({ value: _value, ...rest }) => rest),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${render(plan, !args.dryRun)}\n`);
  }

  if (args.dryRun) return 0;

  const writes = writesOf(plan);
  if (writes.length === 0) return 0;

  // Only create environments that something will actually be written to.
  if (writes.some((row) => row.target.startsWith("environment:")) && github !== null && !github.environmentExists) {
    if (!ensureGithubEnvironment(env)) {
      process.stderr.write(
        `secrets:sync: could not create the "${githubEnvironmentFor(env)}" GitHub Environment ` +
          "(needs admin on the repository). Create it in Settings → Environments and re-run.\n",
      );
      return 1;
    }
    process.stdout.write(`created GitHub Environment "${githubEnvironmentFor(env)}"\n`);
  }

  let failed = 0;
  const failures: string[] = [];
  for (const row of writes) {
    const value = row.value ?? "";
    let ok: boolean;
    if (row.store === "vercel") {
      ok =
        vercel === null
          ? false
          : await writeVercel(row, value, vercel, row.action === "update" ? "update" : "create", source);
    } else {
      ok = writeGithub(row, value, env);
    }
    if (!ok) {
      failed += 1;
      failures.push(`${row.name} → ${row.target}`);
    }
  }

  if (failed > 0) {
    process.stderr.write(
      `\nsecrets:sync: ${failed} write(s) failed:\n${failures.map((f) => `  ✗ ${f}`).join("\n")}\n`,
    );
    return 1;
  }

  process.stdout.write(`\nsecrets:sync: ${writes.length} value(s) written to ${githubEnvironmentFor(env)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`secrets:sync: ${(error as Error).message}\n`);
    process.exit(1);
  });
