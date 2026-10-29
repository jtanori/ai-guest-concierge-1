/**
 * W00-13 — one source of truth (the local env file), many destinations.
 *
 * `secrets:sync` reads `.env.staging`, decides which values belong in which store,
 * and writes only what differs. The decision is pure and lives here so it can be
 * tested without a GitHub token, a Vercel account, or the risk of writing to one.
 *
 * ## The uncomfortable truth about GitHub secrets
 *
 * **A GitHub Actions secret is write-only.** The API lists names and `updated_at`;
 * it never returns a value, by design. So "only sync what changed" cannot be done for
 * secrets the way it can for variables — there is nothing to compare against.
 *
 * The two honest options are (a) rewrite every secret on every run, or (b) skip
 * secrets that are already present and make `--force` the way to rewrite. This
 * module does (b), and says `skip-present` rather than `skip-equal` for exactly that
 * reason: **variables are compared, secrets are only observed.** Conflating the two
 * would let the report claim a comparison that never happened.
 *
 * The practical consequence, stated in the docs: rotating a secret upstream and
 * re-running sync will not push it unless `--force` is passed. That is the price of
 * write-only storage, and it is cheaper than the alternative — a script that silently
 * rewrites forty secrets on every run and rotates `updated_at` for all of them,
 * destroying the one piece of history GitHub offers.
 *
 * ## Vercel
 *
 * Vercel returns values for variables it considers non-sensitive and omits the rest.
 * Where a value comes back, it is compared exactly; where it does not, the same
 * `skip-present` rule applies.
 */
import type { EnvName } from "./env.ts";
import {
  githubEnvironmentFor,
  syncableVariables,
  type Store,
  type VariableSpec,
} from "./manifest.ts";

/** What the destinations currently hold. `null` means "could not be read". */
export interface RemoteState {
  github: {
    /** Names of repository-level Actions secrets. Values are never readable. */
    repoSecrets: Set<string>;
    /** Repository-level Actions variables, with values. */
    repoVariables: Map<string, string>;
    /** Names of secrets on this environment. */
    envSecrets: Set<string>;
    /** This environment's variables, with values. */
    envVariables: Map<string, string>;
    /** False when the environment has never been created. */
    environmentExists: boolean;
  } | null;
  vercel: {
    /** The Vercel target this environment deploys to (`preview` / `production`). */
    target: string;
    /** Name → value when Vercel returned one, `null` when present but unreadable. */
    entries: Map<string, string | null>;
  } | null;
  /**
   * The web tier's Vercel project state. Web-consumer variables with
   * `store: "vercel"` route here instead of the API project. `null` when the
   * web project could not be read (no `VERCEL_WEB_PROJECT_ID`, no token).
   */
  vercelWeb: {
    target: string;
    entries: Map<string, string | null>;
  } | null;
}

/**
 * - `create`  — absent remotely, will be written
 * - `update`  — present with a different value, will be overwritten
 * - `skip-equal` — variables only: compared and identical
 * - `skip-present` — secrets: present, value **not comparable** (write-only)
 * - `skip-absent-from-file` — not in the env file (may still be missing remotely)
 * - `runtime` — the host injects it; not a sync target
 * - `blocked` — the store could not be read, so nothing was decided
 */
export type SyncAction =
  | "create"
  | "update"
  | "skip-equal"
  | "skip-present"
  | "skip-absent-from-file"
  | "runtime"
  | "blocked";

export interface SyncRow {
  name: string;
  store: Store;
  kind: "secret" | "variable";
  /** Human target: `environment:staging`, `repo`, `vercel:preview`, `runtime`. */
  target: string;
  action: SyncAction;
  detail: string;
  /** Present only for rows that will be written; never rendered. */
  value?: string;
}

export interface SyncPlan {
  env: EnvName;
  rows: SyncRow[];
  counts: Record<SyncAction, number>;
  /** Rows that will actually be written. */
  writes: number;
  /** Required values missing from the file — the sync cannot invent them. */
  absent: string[];
}

export interface PlanOptions {
  /**
   * Rewrite secrets that are already present. The only way to push a rotated secret,
   * because the old value cannot be read to compare against.
   */
  force?: boolean;
  /** Limit to these variable names (repeatable `--only`). */
  only?: readonly string[];
}

function targetFor(variable: VariableSpec, env: EnvName): string {
  switch (variable.store) {
    case "github-environment":
      return `environment:${githubEnvironmentFor(env)}`;
    case "github-repo":
      return "repo";
    case "vercel":
      // Web-consumer vercel variables belong on the web project, not the API project.
      return variable.consumer === "web"
        ? `vercel-web:${env === "prod" ? "production" : "preview"}`
        : `vercel:${env === "prod" ? "production" : "preview"}`;
    default:
      return "runtime";
  }
}

/** Which Vercel project state a variable reads from: API or web. */
function vercelStateFor(
  variable: VariableSpec,
  remote: RemoteState,
): { present: boolean; value: string | null | undefined } | "unreadable" {
  if (variable.consumer === "web") {
    if (remote.vercelWeb === null) return "unreadable";
    const entry = remote.vercelWeb.entries.get(variable.name);
    if (entry === undefined) return { present: false, value: undefined };
    return { present: true, value: entry };
  }
  if (remote.vercel === null) return "unreadable";
  const entry = remote.vercel.entries.get(variable.name);
  if (entry === undefined) return { present: false, value: undefined };
  return { present: true, value: entry };
}

/** The remote value, when the store can return one; `undefined` when it cannot. */
function remoteValue(
  variable: VariableSpec,
  remote: RemoteState,
): { present: boolean; value: string | null | undefined } | "unreadable" {
  const store = variable.store;

  if (store === "github-environment" || store === "github-repo") {
    if (remote.github === null) return "unreadable";
    const secrets =
      store === "github-environment" ? remote.github.envSecrets : remote.github.repoSecrets;
    const variables =
      store === "github-environment" ? remote.github.envVariables : remote.github.repoVariables;
    if (variable.secret) {
      // Write-only: presence is all we get, so the value is explicitly unknown.
      return { present: secrets.has(variable.name), value: undefined };
    }
    const value = variables.get(variable.name);
    return { present: value !== undefined, value };
  }

  if (store === "vercel") {
    return vercelStateFor(variable, remote);
  }

  return { present: false, value: undefined };
}

/**
 * Decide, for every variable this environment needs, what to do with it.
 *
 * Never writes anything; the caller executes the `create`/`update` rows.
 */
export function planSync(
  env: EnvName,
  source: Record<string, string>,
  remote: RemoteState,
  options: PlanOptions = {},
): SyncPlan {
  const rows: SyncRow[] = [];
  const only = options.only === undefined ? null : new Set(options.only);
  const absent: string[] = [];

  for (const variable of syncableVariables(env)) {
    if (only !== null && !only.has(variable.name)) continue;

    const kind: "secret" | "variable" = variable.secret ? "secret" : "variable";
    const target = targetFor(variable, env);
    const raw = source[variable.name];
    const value = raw === undefined ? "" : raw.trim();

    if (value === "") {
      // An either/or group is satisfied by its partner: `NEON_AUTH_BASE_URL` being
      // absent is not a gap when `NEON_AUTH_ISSUER` is present.
      const partnerPresent =
        variable.oneOf !== undefined &&
        syncableVariables(env).some(
          (other) =>
            other.oneOf === variable.oneOf &&
            other.name !== variable.name &&
            (source[other.name] ?? "").trim() !== "",
        );
      if (variable.requiredIn.includes(env) && !partnerPresent) absent.push(variable.name);
      rows.push({
        name: variable.name,
        store: variable.store ?? "process",
        kind,
        target,
        action: "skip-absent-from-file",
        detail: "not in the env file — nothing to push",
      });
      continue;
    }

    if (variable.store === undefined || variable.store === "process") {
      rows.push({
        name: variable.name,
        store: variable.store ?? "process",
        kind,
        target: "runtime",
        action: "runtime",
        detail: "supplied by the host at runtime; not a sync target",
      });
      continue;
    }

    const current = remoteValue(variable, remote);
    if (current === "unreadable") {
      rows.push({
        name: variable.name,
        store: variable.store,
        kind,
        target,
        action: "blocked",
        detail: `could not read ${variable.store} — no decision made`,
      });
      continue;
    }

    if (!current.present) {
      rows.push({
        name: variable.name,
        store: variable.store,
        kind,
        target,
        action: "create",
        detail: "absent remotely",
        value,
      });
      continue;
    }

    if (!variable.secret && current.value !== undefined && current.value !== null) {
      const equal = current.value === value;
      rows.push({
        name: variable.name,
        store: variable.store,
        kind,
        target,
        action: equal ? "skip-equal" : "update",
        detail: equal ? "value matches" : "remote value differs",
        ...(equal ? {} : { value }),
      });
      continue;
    }

    // A secret, or a value the store will not return.
    if (options.force === true) {
      rows.push({
        name: variable.name,
        store: variable.store,
        kind,
        target,
        action: "update",
        detail: "present; rewritten because --force was passed",
        value,
      });
      continue;
    }
    rows.push({
      name: variable.name,
      store: variable.store,
      kind,
      target,
      action: "skip-present",
      detail: variable.secret
        ? "present; secret values are write-only, so this was NOT compared (use --force to rewrite)"
        : "present; the store did not return a value to compare (use --force to rewrite)",
    });
  }

  const counts: Record<SyncAction, number> = {
    create: 0,
    update: 0,
    "skip-equal": 0,
    "skip-present": 0,
    "skip-absent-from-file": 0,
    runtime: 0,
    blocked: 0,
  };
  for (const row of rows) counts[row.action] += 1;

  return {
    env,
    rows,
    counts,
    writes: counts.create + counts.update,
    absent,
  };
}

/** The rows the caller must execute, in a stable order (secrets after variables). */
export function writesOf(plan: SyncPlan): SyncRow[] {
  return plan.rows.filter((row) => row.action === "create" || row.action === "update");
}
