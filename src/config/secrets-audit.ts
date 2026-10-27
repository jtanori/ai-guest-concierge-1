/**
 * W00-13 — do the variables exist *where they are needed*?
 *
 * `check:readiness` answers "is this environment complete?" given a set of values.
 * This answers the different, easily-confused question: "will the pipeline actually
 * have them?" The two fail independently. A repository can hold a perfect staging
 * `.env` while the GitHub secret the deploy reads was never created, and the deploy
 * then fails at the migrate step — or worse, succeeds with an empty value that
 * Postgres rejects on the first guest message.
 *
 * ## Unknown is not absent, and neither is present
 *
 * A token that cannot list secrets (`gh` unauthenticated, Vercel unreachable) makes
 * the answer **unknown**, never "fine". This is the whole reason the module returns
 * three states instead of a boolean: a secrets check that reports green because it
 * could not look is the single most misleading thing an audit can do.
 *
 * ## Values never appear
 *
 * No function here receives a secret's value. The inputs are *lists of names* —
 * that is all `gh api .../actions/secrets` and Vercel's env endpoint return, and
 * it is all this audit needs.
 */
import type { EnvName } from "./env.ts";
import { VARIABLES, type Home, type VariableSpec } from "./manifest.ts";

export type PresenceStatus = "present" | "missing" | "unknown" | "not-applicable";

export interface PresenceRow {
  name: string;
  home: Home;
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

export interface Inventories {
  /** Names of repository Actions secrets, or `null` when they could not be listed. */
  github: ReadonlySet<string> | null;
  /**
   * Vercel environment variables by target (`production`, `preview`,
   * `development`), or `null` when they could not be listed.
   */
  vercel: ReadonlyMap<string, ReadonlySet<string>> | null;
  /** Names present in a local `.env` file, or `null` when none was given. */
  local: ReadonlySet<string> | null;
}

/** Which Vercel target an environment deploys to. Staging is Vercel's "preview". */
export function vercelTargetFor(env: EnvName): string {
  return env === "prod" ? "production" : "preview";
}

function auditOne(
  variable: VariableSpec,
  env: EnvName,
  inventories: Inventories,
): PresenceRow {
  const home = variable.home;

  // No home means the platform injects it (the database URL the host is given) or
  // it is defaulted. Nothing to audit from here, and saying "present" would be a lie.
  if (home === undefined) {
    return { name: variable.name, home: "process-env", status: "not-applicable" };
  }

  if (home === "github-secret") {
    if (inventories.github === null) {
      return {
        name: variable.name,
        home,
        status: "unknown",
        detail: "repository secrets could not be listed (no gh auth in this context)",
      };
    }
    return {
      name: variable.name,
      home,
      status: inventories.github.has(variable.name) ? "present" : "missing",
    };
  }

  if (home === "vercel-env") {
    if (inventories.vercel === null) {
      return {
        name: variable.name,
        home,
        status: "unknown",
        detail: "Vercel environment variables could not be listed (no token)",
      };
    }
    const target = vercelTargetFor(env);
    const names = inventories.vercel.get(target) ?? new Set<string>();
    return {
      name: variable.name,
      home,
      status: names.has(variable.name) ? "present" : "missing",
      detail: `target ${target}`,
    };
  }

  // `process-env`: the value arrives from the deployment platform, not from a store
  // this script can read. A local `.env` is the one way to see it before deploy.
  if (inventories.local === null) {
    return {
      name: variable.name,
      home,
      status: "not-applicable",
      detail: "supplied by the platform at runtime",
    };
  }
  return {
    name: variable.name,
    home,
    status: inventories.local.has(variable.name) ? "present" : "missing",
    detail: "from the local .env file",
  };
}

/**
 * Audit every variable the environment requires.
 *
 * Only `requiredIn` variables are audited: chasing the recommended ones produces a
 * list of things nobody is going to do, which is how the important line gets lost.
 */
export function auditSecrets(
  env: EnvName,
  inventories: Inventories,
): AuditResult {
  const required = VARIABLES.filter(
    (variable) => variable.requiredIn.includes(env) && !variable.planned,
  );
  const rows = required.map((variable) => auditOne(variable, env, inventories));

  // Either/or pairs are satisfied by ONE member. Reporting `NEON_AUTH_BASE_URL` as
  // missing while `NEON_AUTH_ISSUER` is present would be a false gap — and a check
  // that cries wolf on its first run is a check that gets an `|| true` appended.
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
    // we could not read) and "not-applicable" (the platform injects it) are both
    // "cannot tell", and inventing a missing value from those is the false alarm
    // that teaches people to ignore the check.
    if (memberRows.some((row) => row.status === "unknown" || row.status === "not-applicable")) {
      continue;
    }
    // Nobody in the group is there: one row speaks for the group, and it says so.
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

/**
 * The variables that live in more than one place for the same environment.
 *
 * `DATABASE_URL` is the case that matters: the deploy workflow needs it as a GitHub
 * secret to run migrations, and the runtime needs it as the platform's env var to
 * serve. They must be the same database — and since the values are secrets, the
 * only checkable form of that claim is the W00-13 gate comparing them at deploy time
 * (`check:env`), which the deploy workflow runs before migrating.
 */
export function dualHomed(env: EnvName): VariableSpec[] {
  return VARIABLES.filter(
    (variable) => variable.requiredIn.includes(env) && variable.home === "github-secret",
  );
}
