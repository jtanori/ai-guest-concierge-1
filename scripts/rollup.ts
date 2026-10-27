/**
 * S10-02 — `npm run rollup`, the operator's recompute.
 *
 *   npm run rollup -- --date 2026-10-25 --org <uuid>
 *   npm run rollup -- --from 2026-10-01 --to 2026-10-25 --org <uuid>
 *   npm run rollup -- --date 2026-10-25 --org <uuid> --dry-run
 *
 * ## Why `--org` and not a bare `--date`
 *
 * The charter's command is `--date YYYY-MM-DD`, and that is what this runs — with
 * one required selector, for the same reason `embed-all` has one: `properties` is
 * FORCE-RLS and org-scoped, so *enumerating every tenant* would mean reading across
 * RLS as the application role, which is the one power the schema refuses to hand
 * out. The org is enough (the policy is `org_id = current_org_id()`), so the script
 * reads that org's properties once and recomputes all of them — a per-property
 * argument would have made the nightly backfill N invocations instead of one.
 * `--property` narrows it when an operator is chasing one hotel.
 *
 * ## Why no scheduling here
 *
 * Nothing in this repo schedules anything (see the S11-03 runbook note). The
 * nightly job that should call this is deferred to S11-01's worker loop / W00-13's
 * durable environments, and until then this is a documented manual command. The
 * output is shaped for a scheduled runner to parse anyway: one line per metric per
 * day, then a total.
 */
import pg from "pg";
import { loadConfig } from "../src/config/env.ts";
import {
  ROLLUP_METRICS,
  rangeForDate,
  runRollups,
  validateRange,
  type RollupRange,
  type RollupResult,
} from "../src/analytics/rollups.ts";
import type { TenantContext } from "../src/db/tenant.ts";

interface Args {
  range: RollupRange;
  orgId: string;
  propertyId: string | null;
  dryRun: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "usage: rollup (--date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD) --org <uuid> [--property <uuid>] [--dry-run]",
    "",
    "  --date      recompute one property-local day",
    "  --from/--to recompute an inclusive range of days (backfill)",
    "  --org       organization to recompute (required: properties are org-scoped under RLS)",
    "  --property  one property of that org instead of all of them",
    "  --dry-run   compute and print, write nothing",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value\n\n${usage()}`);
      }
      values.set(arg.slice(2), next);
      index++;
      continue;
    }
    throw new Error(`unexpected argument "${arg}"\n\n${usage()}`);
  }

  const orgId = values.get("org") ?? "";
  if (!UUID.test(orgId)) throw new Error(`--org must be a uuid\n\n${usage()}`);
  const propertyId = values.get("property") ?? null;
  if (propertyId !== null && !UUID.test(propertyId)) {
    throw new Error(`--property must be a uuid\n\n${usage()}`);
  }

  const date = values.get("date");
  const from = values.get("from");
  const to = values.get("to");
  let range: RollupRange;
  if (date !== undefined) {
    if (from !== undefined || to !== undefined) {
      throw new Error(`--date takes no --from/--to\n\n${usage()}`);
    }
    range = rangeForDate(date);
  } else if (from !== undefined && to !== undefined) {
    range = validateRange({ from, to });
  } else {
    throw new Error(`one of --date or --from with --to is required\n\n${usage()}`);
  }

  return { range, orgId, propertyId, dryRun };
}

interface Target {
  propertyId: string;
  slug: string;
  timeZone: string;
}

/**
 * This org's properties, read as the app role with only the org context set.
 *
 * The `properties` policy is org-scoped on purpose (0002), which is exactly the
 * permission needed here: a property row is visible when its org matches the
 * context, so one transaction with one GUC enumerates the org's hotels and nothing
 * outside it. `SET LOCAL ROLE concierge_app` makes the read pass through the policy
 * even when the connecting role is a superuser (`docker compose`, CI), because a
 * superuser bypasses RLS and would silently prove nothing.
 */
async function listTargets(
  client: pg.Client,
  orgId: string,
  only: string | null,
): Promise<Target[]> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await client.query("SET LOCAL ROLE concierge_app");
    const result = await client.query<{
      property_id: string;
      slug: string;
      time_zone: string;
    }>(
      `SELECT property_id, slug, time_zone
         FROM properties
        WHERE org_id = $1 ${only === null ? "" : "AND property_id = $2"}
        ORDER BY slug`,
      only === null ? [orgId] : [orgId, only],
    );
    return result.rows.map((row) => ({
      propertyId: row.property_id,
      slug: row.slug,
      timeZone: row.time_zone,
    }));
  } finally {
    await client.query("COMMIT").catch(() => undefined);
  }
}

/** `0.5714` reads as "57%" at a glance; `0.5714` next to `12` does not. */
function formatValue(unit: string, value: number): string {
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  if (unit === "seconds") return value >= 60 ? `${(value / 60).toFixed(1)} min` : `${value.toFixed(1)} s`;
  return String(value);
}

function printResult(result: RollupResult, metricUnits: Map<string, string>): void {
  const width = Math.max(...ROLLUP_METRICS.map((m) => m.metric.length));
  for (const row of result.rows) {
    const unit = metricUnits.get(row.metric) ?? "count";
    process.stdout.write(
      `${row.windowStart}  ${row.metric.padEnd(width)}  ${formatValue(unit, row.value).padStart(10)}\n`,
    );
  }
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const config = loadConfig(process.env);
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const targets = await listTargets(client, args.orgId, args.propertyId);
    if (targets.length === 0) {
      process.stderr.write(
        `rollup: no properties visible for org ${args.orgId}` +
          (args.propertyId === null ? "" : ` and property ${args.propertyId}`) +
          " (check the id, and that the connecting role is a member of concierge_app)\n",
      );
      return 1;
    }

    const units = new Map(ROLLUP_METRICS.map((m) => [m.metric, m.unit]));
    let written = 0;
    for (const target of targets) {
      const context: TenantContext = { orgId: args.orgId, propertyId: target.propertyId };
      const result = await runRollups(client, context, args.range, { dryRun: args.dryRun });
      written += result.written;
      process.stdout.write(
        `\n${target.slug} (${target.timeZone}) · ${args.range.from}..${args.range.to}` +
          `${args.dryRun ? " · DRY RUN, nothing written" : ""}\n`,
      );
      printResult(result, units);
      if (result.rows.length === 0) process.stdout.write("  (no rows: nothing happened in this window)\n");
    }

    process.stdout.write(
      `\nrollup: ${targets.length} propert${targets.length === 1 ? "y" : "ies"} · ` +
        `${args.range.from}..${args.range.to} · ` +
        (args.dryRun ? "dry run" : `${written} row${written === 1 ? "" : "s"} written`) +
        "\n",
    );
    return 0;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`rollup: ${(error as Error).message}\n`);
    process.exit(1);
  });
