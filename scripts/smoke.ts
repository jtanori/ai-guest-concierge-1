#!/usr/bin/env node
/**
 * W00-13 — `npm run smoke`, the same checks against any environment.
 *
 *   npm run smoke -- --target staging=https://api.staging.example.com
 *   npm run smoke -- --target staging=https://... --target prod=https://...
 *   npm run smoke -- --target staging=https://... --write        # one real guest turn
 *
 * ## Why several targets in one run
 *
 * The question that matters is not "is staging up?" but "are staging and prod
 * pointing at different things?" Checking them in one invocation makes the
 * comparison possible and the failure legible: a staging target that reports
 * `env: "prod"` is a misconfigured DNS record or a copied secret, and it is
 * indistinguishable from a healthy deploy when each environment is checked alone.
 *
 * ## What `--write` does, and why it is off
 *
 * The read-only checks are health routes. The interesting check is a real guest
 * turn — inbound and outbound `messages`, an AI call, an event — and it costs money
 * and writes rows. So it is opt-in, it is **refused against prod** (`--allow-prod-write`
 * overrides, deliberately awkward), and when enabled it sends a question that is
 * obviously synthetic so nobody mistakes the row for a guest.
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 bad usage.
 */
import process from "node:process";
import { isEnvName, type EnvName } from "../src/config/env.ts";

interface Target {
  env: EnvName;
  url: string;
}

interface Args {
  targets: Target[];
  write: boolean;
  allowProdWrite: boolean;
  timeoutMs: number;
}

function usage(): string {
  return [
    "usage: smoke --target <env>=<url> [--target <env>=<url> ...] [--write] [--timeout-ms 10000]",
    "",
    "  --target        env=url, repeatable (staging=https://api.staging.example.com)",
    "  --write         also send one real guest turn (refused against prod)",
    "  --allow-prod-write  override that refusal; think about it first",
    "  --timeout-ms    per-request timeout, default 10000",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const targets: Target[] = [];
  let write = false;
  let allowProdWrite = false;
  let timeoutMs = 10_000;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--allow-prod-write") {
      allowProdWrite = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value\n\n${usage()}`);
      }
      if (arg === "--target") {
        const equals = next.indexOf("=");
        if (equals === -1) throw new Error(`--target must be <env>=<url>, got "${next}"\n\n${usage()}`);
        const env = next.slice(0, equals);
        const url = next.slice(equals + 1);
        if (!isEnvName(env)) throw new Error(`--target env must be local|staging|prod, got "${env}"`);
        if (!/^https?:\/\//.test(url)) throw new Error(`--target url must be http(s), got "${url}"`);
        targets.push({ env, url: url.replace(/\/+$/, "") });
      } else if (arg === "--timeout-ms") {
        timeoutMs = Number(next);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
          throw new Error("--timeout-ms must be a positive integer");
        }
      } else throw new Error(`unknown option ${arg}\n\n${usage()}`);
      index++;
      continue;
    }
    throw new Error(`unexpected argument "${arg}"\n\n${usage()}`);
  }

  if (targets.length === 0) throw new Error(`at least one --target is required\n\n${usage()}`);
  return { targets, write, allowProdWrite, timeoutMs };
}

interface CheckResult {
  name: string;
  ok: boolean;
  /**
   * Neither pass nor fail: a check that could not be evaluated, reported so a run
   * that skipped everything cannot look green. The bot check is the case that
   * matters — a tokenless CI turn is rejected by design, and calling that a failure
   * would make `--write` permanently red against every real environment.
   */
  skipped?: boolean;
  detail: string;
}

/**
 * One HTTP call, with the two failure modes that must not look alike: a network
 * failure (the host is not there) and a wrong answer (it is there and misconfigured).
 */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: keep the text so the check can say what came back.
    }
    return { status: response.status, body };
  } catch (error) {
    const message = (error as Error).message;
    return { error: message };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function checkTarget(
  target: Target,
  args: Args,
  all: Target[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. /healthz — reachable, and honest about which environment it is.
  const health = await request(`${target.url}/healthz`, { method: "GET" }, args.timeoutMs);
  if ("error" in health) {
    return [{ name: "healthz", ok: false, detail: `unreachable: ${health.error}` }];
  }
  const healthBody = asRecord(health.body);
  results.push({
    name: "healthz",
    ok: health.status === 200,
    detail: `HTTP ${health.status} env=${String(healthBody["env"] ?? "?")} boot=${String(healthBody["boot"] ?? "?")}`,
  });

  // 2. The URL must serve the environment it is labelled with. This is the check
  //    that catches a copied secret pointing staging at the production database.
  results.push({
    name: "env-matches-target",
    ok: healthBody["env"] === target.env,
    detail: `expected ${target.env}, got ${String(healthBody["env"] ?? "<none>")}`,
  });

  // 3. A strict host that reports tolerant is a host whose configuration check is
  //    being skipped — the exact state W00-13's decision exists to prevent.
  if (target.env !== "local") {
    const boot = String(healthBody["boot"] ?? "");
    results.push({
      name: "boot-mode-strict",
      ok: boot === "strict",
      detail:
        boot === "strict"
          ? "strict"
          : `degraded (boot=${boot || "<none>"}) — this host is skipping its config check`,
    });
  }

  // 4. The database, through the app rather than through a psql from CI.
  const postgres = await request(`${target.url}/healthz/postgres`, { method: "GET" }, args.timeoutMs);
  if ("error" in postgres) {
    results.push({ name: "postgres", ok: false, detail: `unreachable: ${postgres.error}` });
  } else {
    results.push({
      name: "postgres",
      ok: postgres.status === 200,
      detail: `HTTP ${postgres.status} database=${String(asRecord(postgres.body)["database"] ?? "?")}`,
    });
  }

  // 5. Two environments must not share a cluster. Compared by hashed
  //    `system_identifier`, never by database name: Neon calls every branch's
  //    database `neondb`, so names collide on deployments that are genuinely
  //    separate — and two databases on ONE cluster are the failure a name can never
  //    show.
  if (!("error" in postgres) && postgres.status === 200 && target.env !== "local") {
    const peer = all.find((other) => other.env !== target.env && other.env !== "local");
    if (peer !== undefined) {
      const peerResult = await request(`${peer.url}/healthz/postgres`, { method: "GET" }, args.timeoutMs);
      const mine = asRecord(postgres.body)["cluster"];
      const theirs = "error" in peerResult ? null : asRecord(peerResult.body)["cluster"];
      if (typeof mine !== "string" || typeof theirs !== "string") {
        results.push({
          name: `cluster-differs-from-${peer.env}`,
          ok: false,
          skipped: true,
          detail: "no cluster fingerprint reported — cannot compare, which is not a pass",
        });
      } else {
        results.push({
          name: `cluster-differs-from-${peer.env}`,
          ok: mine !== theirs,
          detail: mine === theirs ? `both report cluster ${mine} — SHARED DATABASE` : `${mine} ≠ ${theirs}`,
        });
      }
    }
  }

  // 6. Optional: one real guest turn.
  if (args.write) {
    if (target.env === "prod" && !args.allowProdWrite) {
      results.push({
        name: "guest-turn",
        ok: false,
        detail: "refused: --write against prod needs --allow-prod-write",
      });
    } else {
      const turn = await request(
        `${target.url}/api/chat/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: "" },
          body: JSON.stringify({
            // Obviously synthetic: this row must never be mistaken for a guest's.
            slug: process.env["SMOKE_PROPERTY_SLUG"] ?? "demo",
            text: "smoke test — please ignore (automated check)",
          }),
        },
        args.timeoutMs,
      );
      if ("error" in turn) {
        results.push({ name: "guest-turn", ok: false, detail: `unreachable: ${turn.error}` });
      } else {
        const body = asRecord(turn.body);
        const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
        const replied = turn.status === 200 && messages.length >= 2;
        const blocked = body["error"] === "bot_check_failed";
        results.push({
          name: "guest-turn",
          ok: replied,
          ...(blocked ? { skipped: true } : {}),
          detail: replied
            ? `HTTP 200, ${messages.length} messages, decision=${String(body["decision"] ?? "?")}`
            : blocked
              ? "SKIP: bot check enforced and no Turnstile token was sent — the surface is up, the turn is not"
              : `HTTP ${turn.status} ${JSON.stringify(body).slice(0, 140)}`,
        });
      }
    }
  }

  return results;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  let failed = 0;
  let skipped = 0;
  let passed = 0;
  for (const target of args.targets) {
    const results = await checkTarget(target, args, args.targets);
    process.stdout.write(`\n${target.env}  ${target.url}\n`);
    for (const result of results) {
      const label = result.ok ? "PASS" : result.skipped === true ? "SKIP" : "FAIL";
      process.stdout.write(`  ${label}  ${result.name.padEnd(28)} ${result.detail}\n`);
      if (result.ok) passed++;
      else if (result.skipped === true) skipped++;
      else failed++;
    }
  }

  const summary = `${passed} passed, ${skipped} skipped, ${failed} failed`;
  process.stdout.write(
    failed === 0
      ? `\nsmoke: ${args.targets.length} target${args.targets.length === 1 ? "" : "s"} · ${summary}\n`
      : `\nsmoke: ${summary}\n`,
  );
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`smoke: ${(error as Error).message}\n`);
    process.exit(1);
  });
