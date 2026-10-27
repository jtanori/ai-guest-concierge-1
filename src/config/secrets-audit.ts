/**
 * W00-13 — do the variables exist *where they are needed*?
 *
 * `check:readiness` answers "is this environment complete?" given a set of values.
 * This answers the different, easily-confused question: "will the pipeline actually
 * have them?" The two fail independently. A repository can hold a perfect staging
 * `.env` while the secret the deploy job reads was never created, and the deploy then
 * fails at the migrate step — or worse, succeeds with an empty value.
 *
 * ## Unknown is not absent, and neither is present
 *
 * A token that cannot list secrets (`gh` unauthenticated, Vercel unreachable) makes
 * the answer **unknown**, never "fine". This is why the module returns four states
 * instead of a boolean: a secrets check that reports green because it could not look
 * is the single most misleading thing an audit can do.
 *
 * ## Values never appear
 *
 * No function here receives a secret's value. The inputs are lists of names (plus
 * values for the stores that return them) — that is all the GitHub and Vercel APIs
 * give, and it is all this audit needs.
 */
import type { EnvName } from "./env.ts";
import { VARIABLES, type Store, type VariableSpec } from "./manifest.ts";
import type { RemoteState } from "./secrets-sync.ts";

export type PresenceStatus = "present" | "missing" | "unknown" | "not-applicable";

export interface PresenceRow {
  name: string;
  store: Store;
  status: PresenceStatus;
  detail?: string;
}

export interface AuditResult {
  env: EnvName;
  rows: PresenceRow[];
  /** Missing, or unknown, for a variable that must be there. */
  ok: boolean;
  missing: string[];
  unknown: string[];
}

/** Which Vercel target an environment deploys to. Staging is Vercel's "preview". */
export function vercelTargetFor(env: EnvName): string {
  return env === "prod" ? "production" : "preview";
}

function auditOne(
  variable: VariableSpec,
  env: EnvName,
  remote: RemoteState,
  localNames: ReadonlySet<string> | null,
): PresenceRow {
  const store = variable.store ?? "process";

  if (store === "process") {
    // Supplied by the host, or defaulted. A local `.env` is the only way to see it
    // before deploy, and only when one was supplied.
    if (localNames === null) {
      return {
        name: variable.name,
        store,
        status: "not-applicable",
        detail: "supplied by the platform at runtime",
      };
    }
    return {
      name: variable.name,
      store,
      status: localNames.has(variable.name) ? "present" : "missing",
      detail: "from the local .env file",
    };
  }

  if (store === "github-environment" || store === "github-repo") {
    if (remote.github === null) {
      return {
        name: variable.name,
        store,
        status: "unknown",
        detail: "GitHub could not be read (no gh auth in this context)",
      };
    }
    const present =
      store === "github-environment"
        ? variable.secret
          ? remote.github.envSecrets.has(variable.name)
          : remote.github.envVariables.has(variable.name)
        : variable.secret
          ? remote.github.repoSecrets.has(variable.name)
          : remote.github.repoVariables.has(variable.name);
    return {
      name: variable.name,
      store,
      status: present ? "present" : "missing",
      detail:
        store === "github-environment"
          ? variable.secret
            ? "environment secret"
            : "environment variable"
          : "repository-level",
    };
  }

  // vercel
  if (remote.vercel !== null && remote.vercel.target !== vercelTargetFor(env)) {
    // A state read for one target cannot answer for another. Reporting "present"
    // here would let a preview-only variable satisfy a production audit.
    return {
      name: variable.name,
      store,
      status: "unknown",
      detail: `state was read for target "${remote.vercel.target}", not "${vercelTargetFor(env)}"`,
    };
  }
  if (remote.vercel === null) {
    return {
      name: variable.name,
      store,
      status: "unknown",
      detail: "Vercel environment variables could not be listed (no token)",
    };
  }
  return {
    name: variable.name,
    store,
    status: remote.vercel.entries.has(variable.name) ? "present" : "missing",
    detail: `target ${remote.vercel.target}`,
  };
}

/**
 * Audit every variable the environment requires, plus the repo-level plumbing the
 * deploy cannot run without. Only `requiredIn` variables used to be audited — which
 * left `VERCEL_TOKEN` (requiredIn: [], it is not something the *host* needs) invisible
 * to `check:secrets` even though the deploy hard-fails without it. Chasing the
 * recommended ones still produces a list of things nobody is going to do, which is
 * how the important line gets lost; repo plumbing is not recommended, it is load-
 * bearing, so it is audited for every environment.
 */
export function auditSecrets(
  env: EnvName,
  remote: RemoteState,
  localNames: ReadonlySet<string> | null = null,
): AuditResult {
  const required = VARIABLES.filter(
    (variable) =>
      !variable.planned &&
      (variable.requiredIn.includes(env) || variable.store === "github-repo"),
  );
  const rows = required.map((variable) => auditOne(variable, env, remote, localNames));

  // Either/or pairs are satisfied by ONE member. Reporting `NEON_AUTH_BASE_URL` as
  // missing while `NEON_AUTH_ISSUER` is present is a false gap, and a check that
  // cries wolf on its first run gets an `|| true` appended.
  const groups = new Map<string, VariableSpec[]>();
  for (const variable of required) {
    if (!variable.oneOf) continue;
    groups.set(variable.oneOf, [...(groups.get(variable.oneOf) ?? []), variable]);
  }
  for (const members of groups.values()) {
    const memberRows = members
      .map((member) => rows.find((row) => row.name === member.name))
      .filter((row): row is PresenceRow => row !== undefined);
    if (memberRows.some((row) => row.status === "present")) {
      for (const row of memberRows) {
        row.status = "present";
        row.detail = `satisfied by an either/or partner (${members.map((m) => m.name).join(" | ")})`;
      }
      continue;
    }
    // Only claim a gap when every member is definitively absent. "unknown" (a store
    // we could not read) and "not-applicable" (the platform injects it) both mean
    // "cannot tell", and inventing a missing value from those is the false alarm that
    // teaches people to ignore the check.
    if (memberRows.some((row) => row.status === "unknown" || row.status === "not-applicable")) {
      continue;
    }
    for (const [index, row] of memberRows.entries()) {
      if (index === 0) {
        row.status = "missing";
        row.detail = `none of ${members.map((m) => m.name).join(" | ")} is set`;
      } else {
        row.status = "not-applicable";
        row.detail = "covered by the first row of its one-of group";
      }
    }
  }

  const missing = rows.filter((row) => row.status === "missing").map((row) => row.name);
  const unknown = rows.filter((row) => row.status === "unknown").map((row) => row.name);

  return {
    env,
    rows,
    ok: missing.length === 0 && unknown.length === 0,
    missing,
    unknown,
  };
}
