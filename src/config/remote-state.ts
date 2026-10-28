/**
 * W00-13 — reading and writing the places secrets actually live.
 *
 * Split from `secrets-sync.ts` (pure) because this half touches the network and
 * cannot be unit-tested honestly: a mock of the GitHub API would only assert that the
 * mock was called. These functions are deliberately thin, every failure is a
 * `null`/"unreadable" rather than a throw, and `scripts/secrets-sync.ts` decides what
 * that means.
 *
 * `gh` is used for GitHub rather than raw REST because it is already how this repo is
 * administered and it carries the operator's credential — no new secret has to exist
 * for the tool that manages secrets.
 */
import { execFileSync } from "node:child_process";
import { githubEnvironmentFor } from "./manifest.ts";
import type { EnvName } from "./env.ts";
import type { RemoteState } from "./secrets-sync.ts";

export interface CommandRunner {
  (command: string, args: string[], input?: string): string;
}

const defaultRunner: CommandRunner = (command, args, input) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    ...(input === undefined ? {} : { input }),
  });

/** `gh api <path> --jq <expr>`, returning stdout. */
function ghApi(path: string, jq: string, runner: CommandRunner): string {
  return runner("gh", ["api", path, "--jq", jq]);
}

function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Repository and environment state for one environment.
 *
 * Returns `null` when GitHub cannot be read at all (no `gh`, no auth). A missing
 * *environment* is not a failure: it is `environmentExists: false`, which the sync
 * creates and the audit reports, because "staging has no secrets yet" is a state you
 * are about to leave, not an error.
 */
export function readGithubState(
  env: EnvName,
  runner: CommandRunner = defaultRunner,
): RemoteState["github"] {
  const environment = githubEnvironmentFor(env);

  try {
    const repoSecrets = new Set(lines(ghApi("repos/{owner}/{repo}/actions/secrets", ".secrets[].name", runner)));

    const repoVariables = new Map<string, string>();
    for (const line of lines(
      ghApi("repos/{owner}/{repo}/actions/variables", '.variables[] | [.name, .value] | @tsv', runner),
    )) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      repoVariables.set(line.slice(0, tab), line.slice(tab + 1));
    }

    let environmentExists = true;
    let envSecrets = new Set<string>();
    const envVariables = new Map<string, string>();
    try {
      envSecrets = new Set(
        lines(
          ghApi(
            `repos/{owner}/{repo}/environments/${environment}/secrets`,
            ".secrets[].name",
            runner,
          ),
        ),
      );
      for (const line of lines(
        ghApi(
          `repos/{owner}/{repo}/environments/${environment}/variables`,
          '.variables[] | [.name, .value] | @tsv',
          runner,
        ),
      )) {
        const tab = line.indexOf("\t");
        if (tab === -1) continue;
        envVariables.set(line.slice(0, tab), line.slice(tab + 1));
      }
    } catch {
      // 404: the environment has never been created. Not an error — it is the state
      // a first `secrets:sync` fixes.
      environmentExists = false;
    }

    return {
      repoSecrets,
      repoVariables,
      envSecrets,
      envVariables,
      environmentExists,
    };
  } catch {
    return null;
  }
}

export interface VercelState extends NonNullable<RemoteState["vercel"]> {
  /** Environment variable ids, so an update can PATCH the right row. */
  ids: Map<string, string>;
}

/**
 * Vercel environment variables for the target this environment deploys to.
 *
 * `projectId` selects which Vercel project to read: the API project by default,
 * or the web project when `source["VERCEL_WEB_PROJECT_ID"]` is supplied by the
 * caller. `decrypt=true` is requested because some variable types (plain) return
 * their value; sensitive ones never do, and come back as `null` — which the
 * planner treats as "present, not comparable" rather than inventing an equality.
 */
export async function readVercelState(
  env: EnvName,
  source: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  projectIdOverride?: string,
): Promise<VercelState | null> {
  const projectId = projectIdOverride ?? source["VERCEL_PROJECT_ID"];
  const token = source["VERCEL_TOKEN"];
  const teamId = source["VERCEL_ORG_ID"];
  if (!projectId || !token) return null;

  const target = env === "prod" ? "production" : "preview";
  const url = new URL(`https://api.vercel.com/v9/projects/${projectId}/env`);
  if (teamId) url.searchParams.set("teamId", teamId);
  url.searchParams.set("decrypt", "true");

  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      envs?: { id?: string; key?: string; value?: string; target?: string[] | string }[];
    };
    const entries = new Map<string, string | null>();
    const ids = new Map<string, string>();
    for (const entry of body.envs ?? []) {
      if (!entry.key) continue;
      const targets = Array.isArray(entry.target) ? entry.target : [entry.target ?? "production"];
      if (!targets.includes(target)) continue;
      entries.set(entry.key, typeof entry.value === "string" ? entry.value : null);
      if (entry.id) ids.set(entry.key, entry.id);
    }
    return { target, entries, ids };
  } catch {
    return null;
  }
}

/** Create the GitHub Environment if it does not exist yet. Idempotent. */
export function ensureGithubEnvironment(
  env: EnvName,
  runner: CommandRunner = defaultRunner,
): boolean {
  try {
    runner("gh", [
      "api",
      "--method",
      "PUT",
      `repos/{owner}/{repo}/environments/${githubEnvironmentFor(env)}`,
      "--silent",
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write one value to GitHub.
 *
 * The value travels on **stdin**, never in argv. `gh secret set NAME --body "$VALUE"`
 * is the obvious spelling and it is wrong: the value becomes part of the process
 * command line, which `/proc/<pid>/cmdline`, `ps aux` and any crash reporter on the
 * machine can read while `gh` runs. `gh` reads stdin when `--body` is absent, so the
 * value never leaves this process's pipes.
 *
 * Nothing is passed through a shell either, so a value containing `$(...)` or a quote
 * is data rather than code.
 */
export function writeGithub(
  row: { name: string; kind: "secret" | "variable"; target: string },
  value: string,
  env: EnvName,
  runner: CommandRunner = defaultRunner,
): boolean {
  const args = [row.kind === "secret" ? "secret" : "variable", "set", row.name];
  if (row.target.startsWith("environment:")) {
    args.push("--env", githubEnvironmentFor(env));
  }
  try {
    runner("gh", args, value);
    return true;
  } catch {
    return false;
  }
}

/** Create or update one Vercel variable on this environment's target. */
export async function writeVercel(
  row: { name: string; target: string },
  value: string,
  state: VercelState,
  action: "create" | "update",
  source: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  projectIdOverride?: string,
): Promise<boolean> {
  const projectId = projectIdOverride ?? source["VERCEL_PROJECT_ID"];
  const token = source["VERCEL_TOKEN"];
  const teamId = source["VERCEL_ORG_ID"];
  if (!projectId || !token) return false;

  const target = state.target;
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  const id = state.ids.get(row.name);

  try {
    if (action === "update" && id !== undefined) {
      const response = await fetchImpl(
        `https://api.vercel.com/v9/projects/${projectId}/env/${id}${query}`,
        {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ value }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      return response.ok;
    }

    const response = await fetchImpl(`https://api.vercel.com/v10/projects/${projectId}/env${query}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ key: row.name, value, type: "encrypted", target: [target] }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
