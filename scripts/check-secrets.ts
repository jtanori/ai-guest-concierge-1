#!/usr/bin/env node
/**
 * W00-13 — `npm run check:secrets`, an audit of where the values live.
 *
 *   npm run check:secrets -- --env staging
 *   npm run check:secrets -- --env prod --file .env.production
 *
 * The read-only sibling of `secrets:sync`: same stores, same manifest, no writes. Use
 * it when you want to know whether an environment is complete *in its stores* —
 * typically before the first deploy, or when a deploy fails at the migrate step.
 *
 * A store that cannot be read is reported UNKNOWN and fails the run unless
 * `--allow-unknown` is passed. The flag exists so a workflow that cannot reach a
 * third party can say so out loud; it is not the default, because "the check could
 * not run" and "the check passed" are different facts and only one is worth trusting.
 *
 * Exit codes: 0 complete, 1 gaps, 2 nothing could be verified.
 */
import process from "node:process";
import { loadEnvFile, DotenvError } from "../src/config/dotenv.ts";
import { resolveCheckEnv } from "../src/config/preflight.ts";
import { githubEnvironmentFor } from "../src/config/manifest.ts";
import { auditSecrets, vercelTargetFor, type AuditResult } from "../src/config/secrets-audit.ts";
import { readGithubState, readVercelState } from "../src/config/remote-state.ts";

interface Args {
  envRaw: string | undefined;
  file: string | null;
  allowUnknown: boolean;
  json: boolean;
}

function usage(): string {
  return [
    "usage: check:secrets --env local|staging|prod [--file .env.<env>] [--allow-unknown] [--json]",
    "",
    "  --file           also treat this .env file as an inventory for runtime-supplied values",
    "  --allow-unknown  do not fail when a store could not be read (it is still reported)",
    "",
    "exit 0 = every required value is where it must be, 1 = gaps, 2 = nothing could be verified",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  let envRaw: string | undefined;
  let file: string | null = null;
  let allowUnknown = false;
  let json = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--allow-unknown") {
      allowUnknown = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value\n\n${usage()}`);
      }
      if (arg === "--env") envRaw = next;
      else if (arg === "--file") file = next;
      else throw new Error(`unknown option ${arg}\n\n${usage()}`);
      index++;
      continue;
    }
    throw new Error(`unexpected argument "${arg}"\n\n${usage()}`);
  }
  return { envRaw, file, allowUnknown, json };
}

function render(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(
    `environment: ${result.env} · GitHub Environment "${githubEnvironmentFor(result.env)}" · ` +
      `Vercel target ${vercelTargetFor(result.env)}`,
  );
  lines.push(`verdict: ${result.ok ? "COMPLETE" : "GAPS"}`);

  const symbol: Record<string, string> = {
    present: "✓",
    missing: "✗",
    unknown: "?",
    "not-applicable": "·",
  };
  const width = Math.max(...result.rows.map((row) => row.name.length));
  lines.push("", "where each required value must live:");
  for (const row of result.rows) {
    const detail = row.detail === undefined ? "" : `  (${row.detail})`;
    lines.push(`  ${symbol[row.status]} ${row.name.padEnd(width)}  ${row.store.padEnd(19)} ${row.status}${detail}`);
  }

  if (result.missing.length > 0) {
    lines.push("", "missing — `npm run secrets:sync` fills these from a complete env file:");
    for (const name of result.missing) lines.push(`  ✗ ${name}`);
  }
  if (result.unknown.length > 0) {
    lines.push("", "could not verify (this is NOT a pass):");
    for (const name of result.unknown) lines.push(`  ? ${name}`);
  }
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
    env = resolveCheckEnv(args.envRaw);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  let localNames: Set<string> | null = null;
  if (args.file !== null) {
    try {
      localNames = new Set(Object.keys(loadEnvFile(args.file).values));
    } catch (error) {
      const message = error instanceof DotenvError ? error.message : String(error);
      process.stderr.write(`check:secrets: ${message}\n`);
      return 2;
    }
  }

  const github = readGithubState(env);
  const vercel = await readVercelState(env, process.env);
  const result = auditSecrets(env, { github, vercel }, localNames);

  const checkedAnything = result.rows.some(
    (row) => row.status === "present" || row.status === "missing",
  );
  const ok = result.ok || (args.allowUnknown && result.missing.length === 0);
  const code = !checkedAnything ? 2 : ok ? 0 : 1;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        { env: result.env, ok, checkedAnything, missing: result.missing, unknown: result.unknown, rows: result.rows },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${render(result)}\n`);
    if (!checkedAnything) {
      process.stdout.write(
        "\ncheck:secrets: no store could be read — this is not a pass.\n" +
          "  GitHub: needs `gh auth login` (or GITHUB_TOKEN with repo admin)\n" +
          "  Vercel: needs VERCEL_PROJECT_ID and VERCEL_TOKEN\n",
      );
    }
  }
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`check:secrets: ${(error as Error).message}\n`);
    process.exit(1);
  });
