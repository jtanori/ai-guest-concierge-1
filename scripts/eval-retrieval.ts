/**
 * S04-03 — recall@8 on the golden set, as a script rather than a claim.
 *
 * AC-3 is "recall >= 90% on the target articles". That number can only be
 * computed against a golden set the hotel supplied, so this script does two
 * things: it computes the number when the set is big enough, and it REFUSES to
 * report a number when it is not. A silent 100% over five questions is worse
 * than no number at all — it is a gate that reports green while proving
 * nothing.
 *
 *   npm run eval:retrieval -- --org <uuid> --property <uuid> [--min 40] [--stub]
 *
 * `--stub` uses the deterministic vector, so the harness is runnable without a
 * provider key; the vector branch is then meaningless, which is why the run
 * says so in its output.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { loadConfig } from "../src/config/env.ts";
import { withTenant, type TenantContext } from "../src/db/tenant.ts";
import { loadGoldenQuestions, type GoldenQuestion } from "../src/golden/validate.ts";
import { retrieveCurrentVersions, type RetrievalHit } from "../src/knowledge/retrieval.ts";
import { embeddingProviderFromEnv } from "../src/providers/embedding.ts";

const GOLDEN_PATH = "data/golden/golden-questions-v2.csv";
const FALLBACK_PATH = "data/golden/golden-questions-v1.csv";
/** AC-3's threshold. */
const TARGET_RECALL = 0.9;
const K = 8;

interface Args {
  orgId: string;
  propertyId: string;
  minQuestions: number;
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
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const orgId = values.get("org") ?? "";
  const propertyId = values.get("property") ?? "";
  if (!uuid.test(orgId) || !uuid.test(propertyId)) {
    throw new Error("usage: eval-retrieval --org <uuid> --property <uuid> [--min 40] [--stub]");
  }
  const minQuestions = Number(values.get("min") ?? 40);
  if (!Number.isInteger(minQuestions) || minQuestions < 1) {
    throw new Error("--min must be a positive integer");
  }
  return { orgId, propertyId, minQuestions, stub };
}

function goldenPath(): { path: string; present: boolean } {
  try {
    readFileSync(GOLDEN_PATH);
    return { path: GOLDEN_PATH, present: true };
  } catch {
    return { path: FALLBACK_PATH, present: false };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const { path, present } = goldenPath();

  const questions = loadGoldenQuestions(path, {
    minRows: 1,
    propertyLanguages: ["es", "en"],
  });
  const scorable = questions.filter(
    (question: GoldenQuestion) => question.targetTopic !== null,
  );

  console.log(`golden set: ${path} (${scorable.length} scorable questions)`);
  if (!present) {
    console.log(
      "NOTE: golden-questions-v2.csv is absent; AC-3 targets v2 (>= 40 questions, " +
        "hotel-supplied, G1). Numbers below are from v1 and are indicative only.",
    );
  }
  if (args.stub) {
    console.log("NOTE: --stub; the vector branch is SKIPPED (lexical + trigram only).");
  }

  // In --stub mode the vector branch is SKIPPED, not fed placeholder vectors.
  // A hash-based fake vector has no semantic relationship to the question, so
  // including it would rank arbitrary chunks and quietly depress the recall of
  // the two real branches.
  const embed = args.stub
    ? null
    : (() => {
        const provider = embeddingProviderFromEnv(process.env);
        return (text: string) => provider.embed([text]).then((vectors) => vectors[0]!);
      })();

  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  let hits = 0;
  const misses: string[] = [];
  try {
    const context: TenantContext = { orgId: args.orgId, propertyId: args.propertyId };

    for (const question of scorable) {
      const embedding = embed === null ? undefined : await embed(question.question);
      const retrieved: RetrievalHit[] = await withTenant(client, context, async (tx) => {
        await tx.query("SET LOCAL ROLE concierge_app");
        return retrieveCurrentVersions(tx, context, {
          text: question.question,
          ...(embedding === undefined ? {} : { embedding }),
          limit: K,
        });
      });
      const found = retrieved.some((hit) => hit.topicKey === question.targetTopic);
      if (found) hits += 1;
      else {
        misses.push(
          `  MISS  ${question.language}  ${JSON.stringify(question.question)}\n` +
            `        target=${question.targetTopic} got=[${retrieved
              .map((hit) => hit.topicKey)
              .join(", ")}]`,
        );
      }
    }
  } finally {
    await client.end();
  }

  const recall = scorable.length === 0 ? 0 : hits / scorable.length;
  if (misses.length > 0) console.log(misses.join("\n"));
  console.log(
    `recall@${K} = ${hits}/${scorable.length} = ${(recall * 100).toFixed(1)}% ` +
      `(target >= ${(TARGET_RECALL * 100).toFixed(0)}%)`,
  );

  if (scorable.length < args.minQuestions) {
    console.log(
      `UNPROVEN: ${scorable.length} questions is below the ${args.minQuestions} AC-3 needs ` +
        "(golden set v2, G1). This run cannot certify the gate.",
    );
    process.exitCode = 2;
    return;
  }

  if (recall < TARGET_RECALL) {
    console.log("FAIL: recall below target.");
    process.exitCode = 1;
    return;
  }
  console.log("PASS: recall at or above target.");
}

await main();
