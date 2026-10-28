#!/usr/bin/env node
/**
 * W00-13 — `npm run check:env`
 *
 * The acceptance test for "three separate databases; no shared DB". It reads the
 * `DATABASE_URL` out of one file per environment and refuses to pass when two of them
 * point at the same database, or when a deployed environment points at the local one.
 *
 *   npm run check:env -- --staging .env.staging --prod .env.production
 *   npm run check:env -- --staging .env.staging --prod .env.production --local .env
 *
 * Why files rather than `STAGING_DATABASE_URL=...` in the shell: the local `.env*`
 * files are the single source of truth for every value in this project, and a check
 * that needs a *different* spelling of the same variable is a second source of truth
 * waiting to disagree. It also means the command you run to prove separation is the
 * same file the deploy will use, so a typo in one is caught by the other.
 *
 * `--local` is optional. Without it the local-reuse rule cannot be applied — and that
 * is reported, not silently skipped.
 */
import { loadEnvFile, DotenvError } from "../src/config/dotenv.ts";
import { resolveDeploymentEnvironments } from "../src/config/env.ts";

const USAGE = `usage: npm run check:env -- --staging <file> --prod <file> [--local <file>]`;

interface Options {
  staging?: string;
  prod?: string;
  local?: string;
}

function parseArgs(argv: string[]): { staging: string; prod: string; local: string | undefined } {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a file\n${USAGE}`);
    if (arg === "--staging") options.staging = value;
    else if (arg === "--prod" || arg === "--production") options.prod = value;
    else if (arg === "--local") options.local = value;
    else throw new Error(`unknown option ${arg}\n${USAGE}`);
    index += 1;
  }

  const { staging, prod, local } = options;
  if (staging === undefined || prod === undefined) {
    throw new Error(`--staging and --prod are both required\n${USAGE}`);
  }
  return { staging, prod, local };
}

/**
 * `DATABASE_URL` from one file.
 *
 * The file's own `APP_ENV` is cross-checked when it declares one. `.env.staging` with
 * `APP_ENV=prod` inside it would compare production against production and call the
 * result "separate", which is the exact false pass this command exists to prevent.
 */
function databaseUrl(file: string, expected: "local" | "staging" | "prod"): string {
  let values: Record<string, string>;
  try {
    values = loadEnvFile(file).values;
  } catch (error) {
    throw new Error(error instanceof DotenvError ? error.message : `cannot read ${file}`);
  }

  const declared = values["APP_ENV"];
  if (declared !== undefined && declared !== expected) {
    throw new Error(
      `${file} declares APP_ENV=${declared} but was passed as --${expected}; ` +
        `comparing the wrong pair would report a false pass`,
    );
  }

  const url = values["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new Error(`${file} has no DATABASE_URL — there is nothing to compare`);
  }
  return url;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const stagingUrl = databaseUrl(options.staging, "staging");
  const prodUrl = databaseUrl(options.prod, "prod");
  const localUrl = options.local === undefined ? undefined : databaseUrl(options.local, "local");

  const resolved = resolveDeploymentEnvironments({ localUrl, stagingUrl, prodUrl });
  console.log("OK — no shared databases:");
  console.log(`  staging -> ${mask(resolved.stagingUrl)}`);
  console.log(`  prod    -> ${mask(resolved.prodUrl)}`);
  if (localUrl === undefined) {
    console.log("  local   -> not supplied; the local-reuse rule was NOT checked");
  }
} catch (error) {
  console.error(`check:env FAILED: ${(error as Error).message}`);
  process.exit(1);
}

function mask(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<unparsable>";
  }
}
