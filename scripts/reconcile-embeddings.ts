/**
 * S11-05 — `npm run reconcile`, the nightly embedding check.
 *
 *   npm run reconcile -- --org <uuid>
 *   npm run reconcile -- --org <uuid> --property <uuid>
 *
 * ## What it does when it finds drift: nothing
 *
 * It exits **1** and names the violation. The charter forbids auto-repair and the
 * reason is in `src/knowledge/reconcile.ts`: a reconciler that quietly deletes a stale
 * chunk hides the publish path that produced it. A nightly job that "fixes" things is
 * a nightly job that lets a broken deploy run for a month unnoticed.
 *
 * Exit codes match `rollup`/`retention`: 0 clean, 1 drift or no visible properties,
 * 2 bad usage. A scheduler distinguishes "the check ran and found drift" from "the
 * check could not run" — collapsing those two is how a nightly job reports green
 * forever while never once connecting to the database.
 *
 * ## Why `--org` is required
 *
 * Same reason as `rollup`: `properties` is FORCE-RLS and org-scoped, so enumerating
 * tenants would mean reading across RLS as the application role. One org enumerates
 * its own hotels under its own policy.
 */
import pg from "pg";
import { loadConfig } from "../src/config/env.ts";
import {
  EMBEDDING_INVARIANTS,
  describeViolations,
  reconcileEmbeddings,
  type EmbeddingReconcileResult,
} from "../src/knowledge/reconcile.ts";
import type { TenantContext } from "../src/db/tenant.ts";

interface Args {
  orgId: string;
  propertyId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "usage: reconcile --org <uuid> [--property <uuid>]",
    "",
    "  --org       organization to reconcile (required: properties are org-scoped under RLS)",
    "  --property  one property of that org instead of all of them",
    "",
    "exit 0 = all three invariants hold, 1 = drift found (nothing is repaired), 2 = bad usage",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (!arg.startsWith("--")) throw new Error(`unexpected argument "${arg}"\n\n${usage()}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${arg} needs a value\n\n${usage()}`);
    }
    values.set(arg.slice(2), next);
    index++;
  }

  // There is no --dry-run. A check has nothing to dry-run: it reads only.
  for (const key of values.keys()) {
    if (key !== "org" && key !== "property") {
      throw new Error(`unknown option --${key}\n\n${usage()}`);
    }
  }

  const orgId = values.get("org") ?? "";
  if (!UUID.test(orgId)) throw new Error(`--org must be a uuid\n\n${usage()}`);
  const propertyId = values.get("property") ?? null;
  if (propertyId !== null && !UUID.test(propertyId)) {
    throw new Error(`--property must be a uuid\n\n${usage()}`);
  }
  return { orgId, propertyId };
}

interface Target {
  propertyId: string;
  slug: string;
}

/** This org's properties, read through the org-scoped policy as the app role. */
async function listTargets(
  client: pg.Client,
  orgId: string,
  only: string | null,
): Promise<Target[]> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await client.query("SET LOCAL ROLE concierge_app");
    const result = await client.query<{ property_id: string; slug: string }>(
      `SELECT property_id, slug
         FROM properties
        WHERE org_id = $1 ${only === null ? "" : "AND property_id = $2"}
        ORDER BY slug`,
      only === null ? [orgId] : [orgId, only],
    );
    return result.rows.map((row) => ({ propertyId: row.property_id, slug: row.slug }));
  } finally {
    await client.query("COMMIT").catch(() => undefined);
  }
}

function summarize(result: EmbeddingReconcileResult): string {
  return EMBEDDING_INVARIANTS.map(
    (invariant) => `${invariant}=${result.byInvariant[invariant]}`,
  ).join(" ");
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
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    // A nightly check must not hang a runner forever on a wedged connection.
    statement_timeout: 60_000,
  });
  await client.connect();
  try {
    const targets = await listTargets(client, args.orgId, args.propertyId);
    if (targets.length === 0) {
      process.stderr.write(
        `reconcile: no properties visible for org ${args.orgId}` +
          (args.propertyId === null ? "" : ` and property ${args.propertyId}`) +
          " (check the id, and that the connecting role is a member of concierge_app)\n",
      );
      return 1;
    }

    let drift = 0;
    for (const target of targets) {
      const context: TenantContext = { orgId: args.orgId, propertyId: target.propertyId };
      const result = await reconcileEmbeddings(client, context);
      drift += result.violations.length;
      if (result.ok) {
        process.stdout.write(`ok   ${target.slug}  ${summarize(result)}\n`);
      } else {
        process.stderr.write(`DRIFT ${target.slug}\n${describeViolations(result, target.slug)}\n`);
      }
    }

    if (drift === 0) {
      process.stdout.write(
        `\nreconcile: ${targets.length} propert${targets.length === 1 ? "y" : "ies"} · ` +
          "all three invariants hold · nothing to do\n",
      );
      return 0;
    }
    process.stderr.write(
      `\nreconcile: ${drift} violation${drift === 1 ? "" : "s"} across ` +
        `${targets.length} propert${targets.length === 1 ? "y" : "ies"} · ` +
        "NOT repaired (fix the publish path, then re-run)\n",
    );
    return 1;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`reconcile: ${(error as Error).message}\n`);
    process.exit(1);
  });
