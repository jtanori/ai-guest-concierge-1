#!/usr/bin/env node
/**
 * W00-13 — `npm run check:secrets`, where the values have to live, not just exist.
 *
 *   npm run check:secrets -- --env staging --inventory github,vercel,local --file .env.staging
 *   npm run check:secrets -- --env prod --inventory github,vercel
 *
 * Three inventories, each optional and each able to answer "I could not look":
 *
 *   github  — repository Actions secrets. Read through `gh`, which is already how
 *             this repo is administered, so no new credential is introduced.
 *   vercel  — environment variables per target. Read through the documented REST
 *             endpoint with the same VERCEL_TOKEN the preview job uses.
 *   local   — names present in a `.env` file, for the pre-deploy rehearsal.
 *
 * A variable whose inventory could not be read is reported UNKNOWN and fails the
 * run unless `--allow-unknown` is passed. The flag exists because a workflow that
 * cannot reach a third party should be able to say so out loud; it should not be the
 * default, because "the check could not run" and "the check passed" are different
 * facts and only one of them is worth trusting.
 *
 * Exit codes: 0 complete, 1 gaps, 2 nothing could be verified.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { loadEnvFile, DotenvError } from "../src/config/dotenv.ts";
import { resolveCheckEnv } from "../src/config/preflight.ts";
import { auditSecrets, vercelTargetFor, type AuditResult, type Inventories } from "../src/config/secrets-audit.ts";

interface Args {
  envRaw: string | undefined;
  inventories: string[];
  file: string | null;
  allowUnknown: boolean;
  json: boolean;
}

const INVENTORY_NAMES = ["github", "vercel", "local"] as const;
type InventoryName = (typeof INVENTORY_NAMES)[number];

function usage(): string {
  return [
    "usage: check:secrets --env local|staging|prod [--inventory github,vercel,local] [--file .env.<env>] [--allow-unknown] [--json]",
    "",
    "  --inventory    which stores to read (default: every one it can reach)",
    "  --file         also treat this .env file as an inventory",
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
  let inventories: string[] = [...INVENTORY_NAMES];

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
      else if (arg === "--inventory") {
        const requested = next.split(",").map((name) => name.trim());
        for (const name of requested) {
          if (!(INVENTORY_NAMES as readonly string[]).includes(name)) {
            throw new Error(`unknown inventory "${name}" — use ${INVENTORY_NAMES.join(",")}\n\n${usage()}`);
          }
        }
        inventories = requested;
      } else throw new Error(`unknown option ${arg}\n\n${usage()}`);
      index++;
      continue;
    }
    throw new Error(`unexpected argument "${arg}"\n\n${usage()}`);
  }
  return { envRaw, inventories, file, allowUnknown, json };
}

/**
 * Repository Actions secret NAMES. `gh` is used rather than the REST API directly so
 * the same credential that administers the repo answers the question; on a runner
 * `GITHUB_TOKEN` is already in place for it.
 */
function readGithubInventory(): ReadonlySet<string> | null {
  try {
    const output = execFileSync(
      "gh",
      ["api", "repos/{owner}/{repo}/actions/secrets", "--jq", ".secrets[].name"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Vercel environment variable names per target.
 *
 * The project id and token are the same three secrets the preview job uses
 * (VERCEL_ORG_ID / VERCEL_PROJECT_ID / VERCEL_TOKEN); no new credential.
 */
async function readVercelInventory(): Promise<ReadonlyMap<string, ReadonlySet<string>> | null> {
  const projectId = process.env["VERCEL_PROJECT_ID"];
  const token = process.env["VERCEL_TOKEN"];
  const teamId = process.env["VERCEL_ORG_ID"];
  if (!projectId || !token) return null;

  const url = new URL(`https://api.vercel.com/v9/projects/${projectId}/env`);
  if (teamId) url.searchParams.set("teamId", teamId);
  url.searchParams.set("decrypt", "false");

  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      envs?: { key?: string; target?: string[] | string }[];
    };
    const byTarget = new Map<string, Set<string>>();
    for (const entry of body.envs ?? []) {
      if (!entry.key) continue;
      const targets = Array.isArray(entry.target) ? entry.target : [entry.target ?? "production"];
      for (const target of targets) {
        const set = byTarget.get(target) ?? new Set<string>();
        set.add(entry.key);
        byTarget.set(target, set);
      }
    }
    return byTarget;
  } catch {
    return null;
  }
}

function render(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(`environment: ${result.env} (vercel target: ${vercelTargetFor(result.env)})`);
  lines.push(`verdict: ${result.ok ? "COMPLETE" : "GAPS"}`);

  const symbol: Record<string, string> = {
    present: "✓",
    missing: "✗",
    unknown: "?",
    "not-applicable": "·",
  };
  lines.push("", "where each required value must live:");
  for (const row of result.rows) {
    const detail = row.detail === undefined ? "" : `  (${row.detail})`;
    lines.push(`  ${symbol[row.status]} ${row.name.padEnd(32)} ${row.home.padEnd(13)} ${row.status}${detail}`);
  }

  if (result.missing.length > 0) {
    lines.push("", "missing:");
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

  const wanted = new Set(args.inventories as InventoryName[]);

  let local: ReadonlySet<string> | null = null;
  if (args.file !== null) {
    try {
      local = new Set(Object.keys(loadEnvFile(args.file).values));
    } catch (error) {
      const message = error instanceof DotenvError ? error.message : String(error);
      process.stderr.write(`check:secrets: ${message}\n`);
      return 2;
    }
  }

  const inventories: Inventories = {
    github: wanted.has("github") ? readGithubInventory() : null,
    vercel: wanted.has("vercel") ? await readVercelInventory() : null,
    local,
  };

  const result = auditSecrets(env, inventories);

  // "Nothing could be verified" is its own exit code: a workflow must be able to
  // distinguish a broken check from a broken environment.
  const checkedAnything = result.rows.some(
    (row) => row.status === "present" || row.status === "missing",
  );
  const ok = result.ok || (args.allowUnknown && result.missing.length === 0);
  const code = !checkedAnything ? 2 : (ok ? 0 : 1);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          env: result.env,
          ok,
          checkedAnything,
          missing: result.missing,
          unknown: result.unknown,
          rows: result.rows,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${render(result)}\n`);
    if (!checkedAnything) {
      process.stdout.write(
        "\ncheck:secrets: no inventory could be read — this is not a pass.\n" +
          "  github: needs `gh auth login` or GITHUB_TOKEN\n" +
          "  vercel: needs VERCEL_PROJECT_ID and VERCEL_TOKEN\n" +
          "  local:  pass --file .env.<env>\n",
      );
    }
  }
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`check:secrets: ${(error as Error).message}\n`);
    process.exit(2);
  });
