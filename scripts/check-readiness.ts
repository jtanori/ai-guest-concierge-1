#!/usr/bin/env node
/**
 * W00-13 — `npm run check:readiness`, the operator's answer to "can this host boot?"
 *
 *   npm run check:readiness -- --env staging --file .env.staging
 *   npm run check:readiness -- --env prod                    # the process environment
 *   npm run check:readiness -- --env staging --json          # for CI annotations
 *   npm run check:readiness -- --env staging --consumer web  # the Next.js half only
 *
 * Exit codes: 0 ready, 1 not ready, 2 bad usage.
 *
 * Why the exit code is 2 and not 1 for bad usage: the deploy workflow treats "the
 * environment is not ready" (1) and "the check could not run" (2) differently, and
 * collapsing them is how a pipeline reports a green deploy that never checked
 * anything.
 *
 * ## What it prints
 *
 * Every problem it can find, in one pass — not the first. An operator fixing a
 * staging deploy should need one round trip, not seven. Secrets are shown as `set`
 * and their values are scrubbed from every message, including loader messages that
 * were not written with a report in mind.
 */
import process from "node:process";
import { loadEnvFile, DotenvError } from "../src/config/dotenv.ts";
import { ConfigError } from "../src/config/env.ts";
import { checkReadiness, resolveCheckEnv, type ReadinessReport } from "../src/config/preflight.ts";
import type { Consumer } from "../src/config/manifest.ts";

interface Args {
  envRaw: string | undefined;
  file: string | null;
  json: boolean;
  consumer: Consumer | null;
}

const CONSUMERS: readonly Consumer[] = ["api", "web", "ci", "deploy"];

function usage(): string {
  return [
    "usage: check:readiness --env local|staging|prod [--file .env.<env>] [--consumer api|web] [--json]",
    "",
    "  --env       which environment's contract to check (default: local)",
    "  --file      read this .env file instead of the process environment",
    "  --consumer  check only one consumer's requirements (default: all)",
    "  --json      machine-readable output",
    "",
    "exit 0 = ready, 1 = not ready, 2 = the check itself could not run",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  let envRaw: string | undefined;
  let file: string | null = null;
  let json = false;
  let consumer: Consumer | null = null;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value\n\n${usage()}`);
      }
      if (arg === "--env") envRaw = next;
      else if (arg === "--file") file = next;
      else if (arg === "--consumer") {
        if (!CONSUMERS.includes(next as Consumer)) {
          throw new Error(`--consumer must be one of ${CONSUMERS.join(" | ")}\n\n${usage()}`);
        }
        consumer = next as Consumer;
      } else throw new Error(`unknown option ${arg}\n\n${usage()}`);
      index++;
      continue;
    }
    throw new Error(`unexpected argument "${arg}"\n\n${usage()}`);
  }
  return { envRaw, file, json, consumer };
}

/**
 * Render the report as lines an operator scans, not prose they parse.
 *
 * Present-but-optional variables are printed last: the two lists people act on are
 * "missing" and "present", and burying the first under thirty defaults is how the
 * one missing variable gets skimmed past.
 */
function render(report: ReadinessReport): string {
  const lines: string[] = [];
  lines.push(`environment: ${report.env}`);
  lines.push(
    `verdict: ${report.ok ? "READY" : "NOT READY"}` +
      ` (${report.errors.length} error${report.errors.length === 1 ? "" : "s"}, ` +
      `${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"})`,
  );

  if (report.errors.length > 0) {
    lines.push("", "errors:");
    for (const finding of report.errors) lines.push(`  ✗ ${finding.variable}: ${finding.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const finding of report.warnings) lines.push(`  ! ${finding.variable}: ${finding.message}`);
  }

  const shown = report.present.map(
    (variable) => `${variable.name}=${variable.secret ? "set" : variable.shown}`,
  );
  if (shown.length > 0) {
    lines.push("", `present (${shown.length}):`);
    for (const line of shown) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

function main(): number {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  let env: ReadinessReport["env"];
  try {
    env = resolveCheckEnv(args.envRaw);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  let source: Record<string, string | undefined>;
  if (args.file !== null) {
    try {
      source = loadEnvFile(args.file).values;
    } catch (error) {
      const message = error instanceof DotenvError ? error.message : String(error);
      process.stderr.write(`check:readiness: ${message}\n`);
      return 2;
    }
  } else {
    source = process.env;
  }

  // `--consumer` narrows which findings are fatal. It does not hide the others:
  // the report is always the whole truth, the exit code answers the narrower
  // question "can THIS half deploy?".
  const report = checkReadiness(source, env, {
    ...(args.consumer === null ? {} : { consumer: args.consumer }),
  });
  const ok = report.ok;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          env: report.env,
          ok,
          consumer: args.consumer,
          errors: report.errors,
          warnings: report.warnings,
          missing: report.missing,
          // Names only. A JSON report is pasted into CI logs and issue comments.
          present: report.present.map((variable) => variable.name),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${render({ ...report, ok })}\n`);
  }
  return ok ? 0 : 1;
}

try {
  process.exit(main());
} catch (error) {
  const message = error instanceof ConfigError ? error.message : (error as Error).message;
  process.stderr.write(`check:readiness: ${message}\n`);
  process.exit(2);
}
