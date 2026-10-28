#!/usr/bin/env node
/**
 * S06-03 — `npm run eval`: G2 as a number.
 *
 * Runs every golden question through the **real pipeline** (`answerMessage`:
 * policy → sensitive → facts → retrieval → generate → contract → guardrail →
 * persist) against a migrated, seeded database, then scores the outcome four
 * ways (`src/eval/harness.ts`) and prints a markdown table.
 *
 * Two providers:
 *
 *  - default: `createGroundedProvider()` — deterministic, no key, no network.
 *    It measures retrieval and the guardrails, which is what a PR can break.
 *  - `--live`: the production Gemini pair (DEC-2). Used by the nightly canary;
 *    needs `LLM_API_KEY` — the SAME name the app boots with, because `buildAi`
 *    below calls `loadLlmConfig`, which reads `LLM_API_KEY` and nothing else.
 *    A second name for one credential is two places to rotate and one to forget.
 *    Never used in PR CI — a vendor outage must not be able to turn a pull
 *    request red for a reason the author cannot fix, and an LLM key in PR CI is
 *    a key in every fork.
 *
 * Two gates, and they are not the same gate:
 *
 *  - **absolute** (`evaluateGate`, plan Appendix D) — enforced with `--enforce`.
 *    It is the sprint gate, and it is only meaningful once the golden set covers
 *    the articles the property actually has (G1 / golden v2, 25 articles). On a
 *    set that asks about topics with no article, "no answer" is the *correct*
 *    pipeline behaviour, so the absolute numbers are a corpus measurement, not a
 *    product one.
 *  - **regression** (`compareToBaseline`) — always enforced when a baseline
 *    exists. A deterministic set can prove "this change made it worse" today,
 *    without waiting for G1, and that is the part CI can act on.
 *
 * Exit codes: 0 clean, 1 a gate breached, 2 the instrument failed (provider
 * outage or a row the pipeline could not evaluate). Never 0 on a broken run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { answerMessage } from "../src/ai/answer.ts";
import { buildAi } from "../src/guest/runtime.ts";
import { withResilience } from "../src/ai/provider.ts";
import { createGroundedProvider } from "../src/eval/fake-provider.ts";
import {
  baselineFrom,
  compareToBaseline,
  evaluateGate,
  formatPercent,
  scoreEval,
  type EvalBaseline,
  type JudgedQuestion,
  type ObservedDecision,
} from "../src/eval/harness.ts";
import { FALSE_ANSWER_MAX, MIN_QUESTIONS_FOR_GATE, THRESHOLDS } from "../src/eval/thresholds.ts";
import { withTenant, type TenantContext } from "../src/db/tenant.ts";
import { loadGoldenQuestions, type GoldenQuestion } from "../src/golden/validate.ts";
import { DEMO_ORG_ID, DEMO_PROPERTY_ID } from "../src/seed/ids.ts";

interface Args {
  golden: string;
  baseline: string;
  minRows: number;
  updateBaseline: boolean;
  enforce: boolean;
  json: boolean;
  live: boolean;
  url: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const minRowsRaw = value("--min-rows");
  return {
    golden: value("--golden") ?? "data/golden/golden-questions-v1.csv",
    baseline: value("--baseline") ?? "data/golden/eval-baseline.json",
    minRows: minRowsRaw === undefined ? 20 : Number.parseInt(minRowsRaw, 10),
    updateBaseline: argv.includes("--update-baseline"),
    enforce: argv.includes("--enforce"),
    json: argv.includes("--json"),
    live: argv.includes("--live"),
    url: value("--url") ?? process.env["DATABASE_URL"],
  };
}

const tenant: TenantContext = { orgId: DEMO_ORG_ID, propertyId: DEMO_PROPERTY_ID };

/**
 * The eval conversation. One per run, reused by every question: an `ai_runs`
 * row needs a conversation it can hang from, and one conversation per question
 * would add 40 tables' worth of noise to the fixtures for no signal.
 */
async function ensureConversation(client: pg.Client): Promise<string> {
  return withTenant(client, tenant, async (tx) => {
    const existing = await tx.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM conversations WHERE org_id = $1 AND property_id = $2 ORDER BY created_at LIMIT 1",
      [tenant.orgId, tenant.propertyId],
    );
    const first = existing.rows[0];
    if (first !== undefined) return first.conversation_id;

    const channel = await tx.query<{ channel_connection_id: string }>(
      "SELECT channel_connection_id FROM channel_connections WHERE org_id = $1 AND property_id = $2 AND channel = 'web' LIMIT 1",
      [tenant.orgId, tenant.propertyId],
    );
    let channelId = channel.rows[0]?.channel_connection_id;
    if (channelId === undefined) {
      const created = await tx.query<{ channel_connection_id: string }>(
        "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web') RETURNING channel_connection_id",
        [tenant.orgId, tenant.propertyId],
      );
      channelId = created.rows[0]!.channel_connection_id;
    }
    const conversation = await tx.query<{ conversation_id: string }>(
      "INSERT INTO conversations (org_id, property_id, connection_id) VALUES ($1, $2, $3) RETURNING conversation_id",
      [tenant.orgId, tenant.propertyId, channelId],
    );
    return conversation.rows[0]!.conversation_id;
  });
}

function observedFrom(outcome: Awaited<ReturnType<typeof answerMessage>>): {
  observed: ObservedDecision;
  reasonCode: string | null;
  detail: string;
  topics: string[];
  answerTopics: string[];
} {
  switch (outcome.kind) {
    case "answer":
      return {
        observed: "answer",
        reasonCode: outcome.output.reasonCode,
        detail: `${outcome.output.citations.length} citation(s), guard passed`,
        topics: [...new Set(outcome.hits.map((hit) => hit.topicKey))],
        answerTopics: [...new Set(outcome.output.topicKeysUsed)],
      };
    case "fact":
      return {
        observed: "answer",
        reasonCode: null,
        detail: `verified fact ${outcome.topicKey}.${outcome.factKey}`,
        topics: [outcome.topicKey],
        answerTopics: [outcome.topicKey],
      };
    case "escalate":
      return {
        observed: "escalate",
        reasonCode: outcome.reasonCode,
        detail: outcome.detail,
        topics: [],
        answerTopics: [],
      };
    case "no_answer":
      return {
        observed: "no_answer",
        reasonCode: outcome.reasonCode,
        detail: outcome.reasonCode,
        topics: [],
        answerTopics: [],
      };
    case "unavailable":
      return { observed: "unavailable", reasonCode: null, detail: outcome.detail, topics: [], answerTopics: [] };
  }
}

async function judge(
  client: pg.Client,
  conversationId: string,
  question: GoldenQuestion,
  ai: ReturnType<typeof withResilience>,
): Promise<JudgedQuestion> {
  const outcome = await withTenant(client, tenant, async (tx) => {
    // The production request path runs as `concierge_app`, with RLS enforcing
    // the tenant. A harness that ran as the owner would measure a pipeline no
    // guest ever hits.
    await tx.query("SET LOCAL ROLE concierge_app");
    return answerMessage(
      tx,
      tenant,
      {
        conversationId,
        messageId: null,
        text: question.question,
        language: question.language === "en" ? "en" : "es",
        channel: "web",
        // Deliberately NOT `question.targetTopic`: production has no topic
        // classifier yet (S05-02 records that gap), so `topicKey` is null on
        // the real request path. Passing the golden set's own answer here would
        // measure a route no guest takes — and would fail every question on a
        // property whose `enabled_topics` does not happen to list the topic.
        // `targetTopic` is still used, as the retrieval diagnostic.
        topicKey: null,
      },
      { ai },
    );
  });
  return { question, ...observedFrom(outcome) };
}

function printTable(result: ReturnType<typeof scoreEval>, goldenPath: string, armed: boolean): void {
  const { scores, counts, total, answerExpected, escalationExpected } = result;
  console.log("");
  console.log(`## G2 evaluation — ${goldenPath}`);
  console.log("");
  console.log(
    `${total} questions (${answerExpected} answer-expected / ${escalationExpected} escalation-expected)` +
      (armed
        ? ""
        : ` — NOTE: below the ${MIN_QUESTIONS_FOR_GATE} the ${formatPercent(FALSE_ANSWER_MAX)} cap needs`),
  );
  console.log("");
  console.log("| metric | value | limit | verdict |");
  console.log("|---|---|---|---|");
  const verdict = (ok: boolean): string => (ok ? "pass" : "FAIL");
  console.log(
    `| false answer | ${formatPercent(scores.falseAnswer)} (${counts.false_answer}/${total}) | ≤${formatPercent(FALSE_ANSWER_MAX)} | ${verdict(scores.falseAnswer <= FALSE_ANSWER_MAX)} |`,
  );
  console.log(
    `| correct or correctly escalated | ${formatPercent(scores.correctOrEscalation)} (${counts.correct_answer + counts.correct_escalation}/${total}) | ≥${formatPercent(THRESHOLDS.correctOrEscalationMin)} | ${verdict(scores.correctOrEscalation >= THRESHOLDS.correctOrEscalationMin)} |`,
  );
  console.log(
    `| correct escalation | ${formatPercent(scores.correctEscalation)} (${counts.correct_escalation}/${escalationExpected}) | ≥${formatPercent(THRESHOLDS.correctEscalationMin)} | ${verdict(scores.correctEscalation >= THRESHOLDS.correctEscalationMin)} |`,
  );
  console.log(
    `| needless escalation | ${formatPercent(scores.needlessEscalation)} (${counts.needless_escalation}/${answerExpected}) | ≤${formatPercent(THRESHOLDS.needlessEscalationMax)} | ${verdict(scores.needlessEscalation <= THRESHOLDS.needlessEscalationMax)} |`,
  );
  console.log("");

  if (result.misses.length > 0) {
    console.log(`### ${result.misses.length} row(s) off the goldens`);
    console.log("");
    console.log("| bucket | lang | question | observed | reason | detail |");
    console.log("|---|---|---|---|---|---|");
    for (const miss of result.misses) {
      const cell = (value: string): string => value.replaceAll("|", "\\|");
      const detail =
        miss.offTopic === undefined
          ? (miss.detail ?? "")
          : `answered from ${miss.offTopic.answered.join(", ")} — not ${miss.offTopic.target}`;
      console.log(
        `| ${miss.bucket} | ${miss.question.language} | ${cell(miss.question.question)} | ${miss.observed} | ${miss.reasonCode ?? "—"} | ${cell(detail)} |`,
      );
    }
    console.log("");
  }

  const retrieval = result.retrieval;
  console.log(
    `### retrieval: the target topic reached the model for ${retrieval.matched}/${retrieval.checked} answerable questions (${formatPercent(retrieval.rate)})`,
  );
  console.log("");
  if (retrieval.misses.length > 0) {
    console.log(
      "A target topic that never appears here means the property has no current article on it " +
        "— a content gap (G1), not a guardrail failure.",
    );
    console.log("");
    for (const miss of retrieval.misses.slice(0, 15)) {
      console.log(
        `- ${miss.targetTopic} — "${miss.question}" (${miss.language}); retrieved: ${miss.retrieved.length === 0 ? "nothing" : miss.retrieved.join(", ")}`,
      );
    }
    console.log("");
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.url === undefined) {
    console.error("eval: no database. Set DATABASE_URL or pass --url <dsn>.");
    return 2;
  }

  const questions = loadGoldenQuestions(args.golden, {
    minRows: args.minRows,
    propertyLanguages: ["es", "en"],
  });

  let ai: ReturnType<typeof withResilience>;
  if (args.live) {
    if ((process.env["LLM_API_KEY"] ?? "").trim() === "") {
      console.error(
        "eval: --live needs LLM_API_KEY (the canary job reads it from the staging environment). " +
          "The canary never falls back to a stub.",
      );
      return 2;
    }
    ai = buildAi(process.env);
  } else {
    const primary = createGroundedProvider();
    ai = withResilience(primary, createGroundedProvider("eval-grounded-fallback-2026-01-01"), {
      retries: 0,
      sleep: async () => {},
    });
  }

  const client = new pg.Client({ connectionString: args.url });
  client.on("error", () => undefined);
  await client.connect();
  let exitCode = 0;
  try {
    const conversationId = await ensureConversation(client);

    const judged: JudgedQuestion[] = [];
    for (const question of questions) {
      judged.push(await judge(client, conversationId, question, ai));
    }
    const result = scoreEval(judged);
    const gate = evaluateGate(result);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            golden: args.golden,
            live: args.live,
            total: result.total,
            counts: result.counts,
            scores: result.scores,
            retrieval: result.retrieval,
            gate,
            misses: result.misses.map((miss) => ({
              bucket: miss.bucket,
              language: miss.question.language,
              question: miss.question.question,
              observed: miss.observed,
              reasonCode: miss.reasonCode,
              detail: miss.detail ?? null,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      printTable(result, args.golden, gate.armed);
      console.log(`absolute gate: ${gate.pass ? "pass" : "FAIL"} — ${gate.note}`);
      for (const breach of gate.breaches) {
        console.log(
          `  - ${breach.metric}: ${formatPercent(breach.value)} vs ${breach.relation} ${formatPercent(breach.limit)} — ${breach.detail}`,
        );
      }
      if (!args.enforce && !gate.pass) {
        console.log(
          "  (not enforced: pass --enforce once the golden set covers the property's articles)",
        );
      }
    }

    // A broken instrument always fails, enforced or not: "0% false answers"
    // measured while the model was unreachable is a lie with a nice table.
    if (result.counts.outage > 0) {
      console.error(`eval: ${result.counts.outage} question(s) hit a provider outage — no measurement.`);
      return 2;
    }

    if (args.updateBaseline) {
      const baseline = baselineFrom(result, args.golden);
      writeFileSync(args.baseline, `${JSON.stringify(baseline, null, 2)}\n`);
      console.log(`\nbaseline recorded: ${args.baseline}`);
    } else if (existsSync(args.baseline)) {
      const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as EvalBaseline;
      const breaches = compareToBaseline(result, baseline);
      if (breaches.length === 0) {
        console.log(`regression gate: pass (baseline ${args.baseline})`);
      } else {
        exitCode = 1;
        console.error(`regression gate: FAIL (baseline ${args.baseline})`);
        for (const breach of breaches) {
          console.error(`  - ${breach.metric}: ${breach.value} vs ${breach.limit} — ${breach.detail}`);
        }
      }
    } else {
      console.log(`regression gate: no baseline at ${args.baseline} (record one with --update-baseline)`);
    }

    if (args.enforce && !gate.pass) exitCode = 1;
    return exitCode;
  } finally {
    await client.end();
  }
}

const code = await main();
process.exitCode = code;
