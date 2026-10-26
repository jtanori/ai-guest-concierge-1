/**
 * S04-02 — backfill chunks for a tenant's already-published articles.
 *
 * Needed because "publish" gained a second half after some databases already
 * had current versions: those versions have a body and a whole-body vector but
 * no chunks, so retrieval over chunks would miss them entirely.
 *
 * Tenant-scoped on purpose. There is no "--all tenants" mode: enumerating
 * organizations would mean reading across RLS as the application role, which is
 * exactly the power the schema refuses to hand out. Run it once per property:
 *
 *   npm run embed:all -- --org <uuid> --property <uuid>
 *   npm run embed:all -- --org <uuid> --property <uuid> --stub   # no API key
 *
 * `--stub` uses the same deterministic vector the seed uses, for local and CI
 * databases only; a stub vector is meaningless for real retrieval.
 */
import pg from "pg";
import { loadConfig } from "../src/config/env.ts";
import { withTenant, type TenantContext } from "../src/db/tenant.ts";
import { chunkBody } from "../src/knowledge/chunk.ts";
import { backfillChunks, type BatchEmbedder } from "../src/knowledge/reembed.ts";
import { embeddingProviderFromEnv } from "../src/providers/embedding.ts";
import { stubEmbedding } from "../src/seed/embedding.ts";

interface Args {
  orgId: string;
  propertyId: string;
  stub: boolean;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let stub = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--stub") {
      stub = true;
      continue;
    }
    if (arg.startsWith("--")) {
      values.set(arg.slice(2), argv[index + 1] ?? "");
      index++;
    }
  }
  const orgId = values.get("org") ?? "";
  const propertyId = values.get("property") ?? "";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(orgId) || !uuid.test(propertyId)) {
    throw new Error("usage: embed-all --org <uuid> --property <uuid> [--stub]");
  }
  return { orgId, propertyId, stub };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);

  const embed: BatchEmbedder = args.stub
    ? async (texts) => texts.map((text) => stubEmbedding(text))
    : (() => {
        const provider = embeddingProviderFromEnv(process.env);
        return (texts: readonly string[]) => provider.embed(texts);
      })();

  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const context: TenantContext = { orgId: args.orgId, propertyId: args.propertyId };

    // Which current versions need (re)chunking? Read first, under the tenant's
    // own context, so RLS decides what is visible.
    //
    // "Zero chunks" is not the only broken state: a half-written set (one chunk
    // of three) is just as retrievable-wrong, and it is what an interrupted run
    // or a manual repair leaves behind. The expected count is cheap to compute
    // — `chunkBody` is pure — so compare against it rather than against zero.
    const pending = await withTenant(client, context, async (tx) => {
      await tx.query("SET LOCAL ROLE concierge_app");
      const result = await tx.query<{
        article_version_id: string;
        body: string;
        chunk_count: string;
      }>(
        `SELECT av.article_version_id,
                av.body,
                (SELECT count(*) FROM article_chunks c
                  WHERE c.article_version_id = av.article_version_id) AS chunk_count
           FROM article_versions av
          WHERE av.is_current AND av.body IS NOT NULL
          ORDER BY av.article_id`,
      );
      return result.rows
        .filter((row) => Number(row.chunk_count) !== chunkBody(row.body).length)
        .map((row) => row.article_version_id);
    });

    let written = 0;
    for (const articleVersionId of pending) {
      await withTenant(client, context, async (tx) => {
        await tx.query("SET LOCAL ROLE concierge_app");
        const result = await backfillChunks(tx, context, articleVersionId, embed);
        written += result.chunkCount;
      });
      console.log(`chunked ${articleVersionId}`);
    }
    console.log(JSON.stringify({ versions: pending.length, chunks: written }));
  } finally {
    await client.end();
  }
}

await main();
