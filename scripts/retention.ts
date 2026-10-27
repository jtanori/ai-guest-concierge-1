/**
 * S11-03 / AC-2 — the documented deletion path for `messages.body`.
 *
 *   npm run retention -- --org <uuid>              # DRY RUN: counts only
 *   npm run retention -- --org <uuid> --apply      # redacts, prints counts
 *   npm run retention -- --org <uuid> --days 30 --apply
 *
 * ## Dry run is the default, and that is a safety property
 *
 * This is the only command in the repository that destroys guest text. A tool that
 * deletes rows the first time you try it is a tool somebody runs by accident on the
 * wrong database, so `--apply` is required and its absence prints exactly what
 * *would* change. The decision to run it against staging or production belongs to
 * the owner, not to a schedule — nothing here is wired to a cron (see the S10-02
 * runbook entry's DEC-1).
 *
 * ## What "delete" means here
 *
 * The row survives; the **text** does not. `body` becomes empty and
 * `body_redacted_at` records when. Deleting the rows would silently rewrite every
 * historical count that reads `messages` — conversation totals, the inbound/outbound
 * reconciliation, S10-02's rollups for old days. Retention is about the guest's
 * words, not about the hotel's numbers, so the numbers stay and the words go.
 *
 * ## Per-tenant, and one failure does not stop the rest
 *
 * Each property runs in its own transaction with its own tenant context: a property
 * whose settings are corrupt, or whose statement times out, must not prevent the
 * other hotels from being handled. Failures are collected, printed by slug, and turn
 * into a non-zero exit at the end.
 *
 * ## Nothing here ever prints a body
 *
 * Counts, slugs and cutoffs only. A retention log that quoted what it deleted would
 * be a second copy of the data, kept for a different length of time, in a system with
 * a different access list — which is the exact problem it is meant to solve.
 */
import pg from "pg";
import { loadConfig } from "../src/config/env.ts";
import type { TenantContext } from "../src/db/tenant.ts";
import { redactExpiredMessages, type RetentionOutcome } from "../src/security/retention.ts";
import { parsePropertySettings } from "../src/settings/schema.ts";

interface Args {
  orgId: string;
  propertyId: string | null;
  days: number | null;
  apply: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "usage: retention --org <uuid> [--property <uuid>] [--days N] [--apply]",
    "",
    "  --org       organization whose properties are scanned (required: properties are",
    "              org-scoped under RLS, so there is no all-tenant mode)",
    "  --property  one property instead of all of them",
    "  --days      override the property's settings.retention_days (default 90)",
    "  --apply     actually redact; without it this is a dry run",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--apply") {
      apply = true;
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
  const daysRaw = values.get("days");
  let days: number | null = null;
  if (daysRaw !== undefined) {
    days = Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error(`--days must be a whole number of days between 1 and 3650`);
    }
  }
  return { orgId, propertyId, days, apply };
}

interface Target {
  propertyId: string;
  slug: string;
  retentionDays: number;
}

/**
 * The org's properties and the retention window each one has configured.
 *
 * Same RLS shape as `npm run rollup`: one transaction, `app.current_org_id`, and
 * `SET LOCAL ROLE concierge_app` so a superuser connection still passes through the
 * policy instead of bypassing it.
 */
async function listTargets(
  client: pg.Client,
  orgId: string,
  only: string | null,
  overrideDays: number | null,
): Promise<Target[]> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await client.query("SET LOCAL ROLE concierge_app");
    const result = await client.query<{
      property_id: string;
      slug: string;
      settings: unknown;
    }>(
      `SELECT property_id, slug, settings
         FROM properties
        WHERE org_id = $1 ${only === null ? "" : "AND property_id = $2"}
        ORDER BY slug`,
      only === null ? [orgId] : [orgId, only],
    );
    return result.rows.map((row) => ({
      propertyId: row.property_id,
      slug: row.slug,
      // The settings document is the source of truth for the window (AC-2's
      // "default 90" is `DEFAULT_SETTINGS.retention_days`); `--days` exists for a
      // deliberate one-off and is never persisted.
      retentionDays: overrideDays ?? parsePropertySettings(row.settings).retention_days,
    }));
  } finally {
    await client.query("COMMIT").catch(() => undefined);
  }
}

interface Outcome extends RetentionOutcome {
  slug: string;
}

async function runOne(
  client: pg.Client,
  orgId: string,
  target: Target,
  apply: boolean,
): Promise<Outcome> {
  const context: TenantContext = { orgId, propertyId: target.propertyId };
  // The statement and its predicate live in `src/security/retention.ts`, where the
  // db test can exercise them without spawning this CLI.
  const outcome = await redactExpiredMessages(client, context, {
    days: target.retentionDays,
    apply,
  });
  return { slug: target.slug, ...outcome };
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
    const targets = await listTargets(client, args.orgId, args.propertyId, args.days);
    if (targets.length === 0) {
      process.stderr.write(`retention: no properties visible for org ${args.orgId}\n`);
      return 1;
    }

    const outcomes: Outcome[] = [];
    const failures: { slug: string; message: string }[] = [];
    for (const target of targets) {
      try {
        outcomes.push(await runOne(client, args.orgId, target, args.apply));
      } catch (error) {
        // One tenant's failure is recorded and skipped; the rest still run.
        failures.push({ slug: target.slug, message: (error as Error).message });
      }
    }

    for (const outcome of outcomes) {
      process.stdout.write(
        `${outcome.slug.padEnd(24)} retention ${String(outcome.days).padStart(3)}d  ` +
          `${outcome.applied ? "REDACTED" : "would redact"} ${outcome.count} message` +
          `${outcome.count === 1 ? "" : "s"}\n`,
      );
    }
    for (const failure of failures) {
      process.stderr.write(`${failure.slug.padEnd(24)} FAILED: ${failure.message}\n`);
    }

    const total = outcomes.reduce((sum, outcome) => sum + outcome.count, 0);
    process.stdout.write(
      `\nretention: ${targets.length} propert${targets.length === 1 ? "y" : "ies"} · ` +
        `${total} message${total === 1 ? "" : "s"} ` +
        (args.apply ? "redacted" : "would be redacted (dry run — pass --apply)") +
        `${failures.length === 0 ? "" : ` · ${failures.length} FAILED`}\n`,
    );
    return failures.length === 0 ? 0 : 1;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`retention: ${(error as Error).message}\n`);
    process.exit(1);
  });
