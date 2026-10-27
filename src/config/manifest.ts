/**
 * W00-13 — the environment contract, as data.
 *
 * Before this file, "what does staging need?" was answerable only by reading six
 * loaders in five modules and a commented-out `.env.example`. That is how an
 * environment ends up missing exactly one variable: the deploy succeeds, the health
 * check passes, and the first guest to open the chat meets a 503 that nobody is
 * watching. The list below is the answer, in one place, and every entry names the
 * loader that enforces it.
 *
 * ## Three ideas, deliberately kept separate
 *
 *  - **`requiredIn`** — missing here fails the readiness check and, outside `local`,
 *    fails the boot (see `resolveBootMode`). This is the hard contract.
 *  - **`recommendedIn`** — missing here is a warning, never a failure. Used for
 *    `local`, where a developer without a Turnstile key should still be able to run
 *    the suite. A warning that blocks work is a warning people learn to bypass.
 *  - **`store`** — WHERE the value has to exist for a deployed environment. A
 *    variable can be correct in the repo and absent in the place that actually
 *    deploys it; that is the gap `check-secrets.ts` reports and `secrets:sync`
 *    closes.
 *
 * ## One name, one environment — never a suffix per environment
 *
 * `LLM_API_KEY` exists exactly once as a name, with one value on the `staging`
 * GitHub Environment and another on `production`. It is NOT `STAGING_LLM_API_KEY`
 * and `PROD_LLM_API_KEY`: suffixed names double the contract, and the day somebody
 * adds `LLM_TIMEOUT_MS` they must remember to add two entries, pick the right one in
 * the workflow, and keep both in step. A job that declares `environment: staging`
 * resolves `secrets.LLM_API_KEY` to staging's value. That is the whole mechanism,
 * and the workflow never mentions the environment in a variable name.
 *
 * ## What is NOT in here
 *
 * `SENTRY_DSN` is listed but never enforced: W00-14 has no reporter wired yet, so
 * requiring it would fail a production deploy over a feature that does not exist.
 * A manifest that demands things it cannot use trains people to ignore it.
 */
import type { EnvName } from "./env.ts";

/**
 * Who reads the variable. The API and the web tier deploy separately and have
 * different requirements — the Next.js build needs `REVIEW_API_URL`, the API does
 * not care about it, and conflating the two is how a web deploy ships broken
 * because the API's checklist was green.
 */
export type Consumer = "api" | "web" | "ci" | "deploy";

/**
 * Where a value lives.
 *
 *  - `github-environment` — a secret or variable attached to a GitHub Environment
 *    (`staging` / `production`). The same name in both; the job's `environment:`
 *    decides which value it sees. The default for anything that differs between
 *    deployments.
 *  - `github-repo` — repository-level, identical for every environment. Only for
 *    credentials that deploy the pipeline itself (the Vercel token), which are not
 *    per-environment facts.
 *  - `vercel` — a Vercel project environment variable on the target this environment
 *    deploys to (`preview` for staging, `production` for prod).
 *  - `process` — injected by the host at runtime; not synced, and reported as such
 *    rather than silently ignored.
 */
export type Store = "github-environment" | "github-repo" | "vercel" | "process";

export interface VariableSpec {
  name: string;
  consumer: Consumer;
  /** Missing → failure. */
  requiredIn: readonly EnvName[];
  /** Missing → warning. */
  recommendedIn?: readonly EnvName[];
  /** Never printed, never logged, never in a report. */
  secret: boolean;
  /**
   * Variables that satisfy each other (an issuer is `NEON_AUTH_ISSUER` **or**
   * `NEON_AUTH_BASE_URL`). One member of a group present is enough.
   */
  oneOf?: string;
  store?: Store;
  /** Why it exists, in the terms of the thing that breaks without it. */
  why: string;
  /**
   * True when the variable is documented but not yet enforced. Shown as
   * "not enforced" rather than silently counted as optional.
   */
  planned?: boolean;
}

const ALL: readonly EnvName[] = ["local", "staging", "prod"];
const DEPLOYED: readonly EnvName[] = ["staging", "prod"];

export const VARIABLES: readonly VariableSpec[] = [
  {
    name: "APP_ENV",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: false,
    store: "process",
    why: "selects the whole config matrix; an unset value defaults to local, which is the one environment that tolerates everything else being missing",
  },
  {
    name: "DATABASE_URL",
    consumer: "api",
    requiredIn: ALL,
    secret: true,
    store: "github-environment",
    why: "every environment points at its own database; the deploy job runs migrations with the value from its own GitHub Environment",
  },
  {
    name: "LOG_LEVEL",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "process",
    why: "defaults to debug locally and info elsewhere; set it to quiet a noisy host",
  },
  {
    name: "APP_NAME",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "process",
    why: "defaulted; only set it to distinguish two deployments in one log sink",
  },
  {
    name: "NEON_AUTH_JWKS_URL",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: false,
    store: "github-environment",
    why: "staff tokens cannot be verified without it, so every staff route answers 503",
  },
  {
    name: "NEON_AUTH_ISSUER",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: false,
    oneOf: "auth-issuer",
    store: "github-environment",
    why: "token issuer check; falls back to NEON_AUTH_BASE_URL",
  },
  {
    name: "NEON_AUTH_BASE_URL",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: false,
    oneOf: "auth-issuer",
    store: "github-environment",
    why: "doubles as the issuer when NEON_AUTH_ISSUER is unset",
  },
  {
    name: "NEON_AUTH_AUDIENCE",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "defaulted to the issuer; override only if the branch's tokens carry a different audience",
  },
  {
    name: "GUEST_COOKIE_SECRET",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: true,
    store: "github-environment",
    why: "signs the anonymous guest identity cookie; a default would be a published signing key",
  },
  {
    name: "GUEST_PUBLIC_URL",
    consumer: "api",
    requiredIn: DEPLOYED,
    secret: false,
    store: "github-environment",
    why: "the bare origin a QR code encodes; unset, a printed card points at an internal hostname",
  },
  {
    name: "LLM_PRIMARY_MODEL",
    consumer: "api",
    requiredIn: ALL,
    secret: false,
    store: "github-environment",
    why: "the pinned model id; never defaulted, because a floating alias is a different model in six months",
  },
  {
    name: "LLM_FALLBACK_MODEL",
    consumer: "api",
    requiredIn: ALL,
    secret: false,
    store: "github-environment",
    why: "the second pinned model; the same id twice is the same failure twice",
  },
  {
    name: "LLM_API_KEY",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: true,
    store: "github-environment",
    why: "without it the host cannot answer a single guest message",
  },
  {
    name: "LLM_BASE_URL",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "defaulted to the Gemini endpoint",
  },
  {
    name: "LLM_TIMEOUT_MS",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "defaulted to 8s; bounded by the guest's patience, not by a vendor's SLA",
  },
  {
    name: "LLM_RETRIES",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "defaulted to two; the ceiling is four because the guest is the one waiting",
  },
  {
    name: "EMBEDDING_API_KEY",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: true,
    store: "github-environment",
    why: "the vector branch of retrieval; without it the product answers from lexical + trigram only",
  },
  {
    name: "EMBEDDING_MODEL",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "defaulted to the model that emits the 1536 dimensions D3 locked",
  },
  {
    // A tuning knob with a working default. Listed so the template cannot document a
    // name the code no longer reads — and so `secrets:sync` places it when a property
    // genuinely wants a longer batch timeout.
    name: "EMBEDDING_TIMEOUT_MS",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "per-request timeout for the embedding provider; 20000 by default",
  },
  {
    name: "EMBEDDING_BATCH_SIZE",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "chunks per embedding request, 1..128; 16 by default",
  },
  {
    name: "EMBEDDING_BASE_URL",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "defaulted to the OpenAI endpoint",
  },
  {
    name: "TURNSTILE_SECRET",
    consumer: "api",
    requiredIn: DEPLOYED,
    secret: true,
    store: "github-environment",
    why: "the bot check on the first guest message; a control that is on only if someone remembered is off",
  },
  {
    name: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    consumer: "web",
    requiredIn: DEPLOYED,
    secret: false,
    store: "vercel",
    why: "without the site key no widget renders, so the server's bot check has no token to verify",
  },
  {
    name: "EMAIL_FROM",
    consumer: "api",
    requiredIn: ALL,
    secret: false,
    store: "github-environment",
    why: "the escalation sender; a default would be a published address every deployment shares",
  },
  {
    name: "EMAIL_API_KEY",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: true,
    store: "github-environment",
    why: "the provider key; without it a queued escalation is a row nobody sends",
  },
  {
    name: "EMAIL_ESCALATION_FALLBACK",
    consumer: "api",
    requiredIn: DEPLOYED,
    secret: false,
    store: "github-environment",
    why: "where a request goes when the property configured no contacts; no default exists on purpose",
  },
  {
    name: "CONSOLE_BASE_URL",
    consumer: "api",
    requiredIn: DEPLOYED,
    secret: false,
    store: "github-environment",
    why: "builds the link in every escalation email; the local default points recipients at their own machine",
  },
  {
    name: "REVIEW_API_URL",
    consumer: "web",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: false,
    store: "vercel",
    why: "the only address the staff screen calls, from the Next server, never the browser",
  },
  {
    // S07-05's outage switch. Refusing it in prod is enforced in code, not here:
    // this entry exists so the variable is documented and not required anywhere.
    name: "AI_FAIL_MODE",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "process",
    why: "none | once | always — turns an AI outage into an input; refused when APP_ENV=prod",
  },
  {
    name: "TURNSTILE_TIMEOUT_MS",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "how long the bot check waits before treating the check as unavailable; 3000 by default",
  },
  {
    name: "SENTRY_DSN",
    consumer: "api",
    requiredIn: [],
    secret: true,
    store: "github-environment",
    planned: true,
    why: "W00-14 error tracking — listed so the gap is visible, not enforced until a reporter is wired",
  },
  {
    name: "ALLOW_DEGRADED_BOOT",
    consumer: "api",
    requiredIn: [],
    secret: false,
    store: "process",
    why: "staging-only escape hatch for preview hosts; refused outright in prod (see resolveBootMode)",
  },
  {
    // The deploy workflow's smoke target. An environment variable rather than a
    // secret because a public origin is public, and CI-only rather than a product
    // requirement because nothing boots differently without it.
    name: "API_URL",
    consumer: "ci",
    requiredIn: [],
    secret: false,
    store: "github-environment",
    why: "the origin `smoke` probes after deploying; absent, the smoke step skips visibly instead of pretending",
  },
  {
    // Deployment plumbing for the pipeline itself, not for the product. Repo-level
    // because the same Vercel project deploys every environment; putting it on an
    // environment would mean three copies of one credential.
    name: "VERCEL_TOKEN",
    consumer: "ci",
    requiredIn: [],
    secret: true,
    store: "github-repo",
    why: "deploys the Vercel surface; one token for one project, so it is repo-level and not per-environment",
  },
  {
    name: "VERCEL_ORG_ID",
    consumer: "ci",
    requiredIn: [],
    secret: false,
    store: "github-repo",
    why: "identifies the Vercel team; identical across environments",
  },
  {
    name: "VERCEL_PROJECT_ID",
    consumer: "ci",
    requiredIn: [],
    secret: false,
    store: "github-repo",
    why: "identifies the Vercel project; identical across environments",
  },
];

export const VARIABLE_BY_NAME: ReadonlyMap<string, VariableSpec> = new Map(
  VARIABLES.map((variable) => [variable.name, variable]),
);

/** The hard requirements for one environment and one consumer. */
export function requiredVariables(env: EnvName, consumer: Consumer): VariableSpec[] {
  return VARIABLES.filter(
    (variable) => variable.consumer === consumer && variable.requiredIn.includes(env),
  );
}

/** Everything that must be present for one environment, across every consumer. */
export function requirementsFor(env: EnvName): {
  required: VariableSpec[];
  recommended: VariableSpec[];
} {
  return {
    required: VARIABLES.filter((variable) => variable.requiredIn.includes(env)),
    recommended: VARIABLES.filter(
      (variable) => (variable.recommendedIn ?? []).includes(env),
    ),
  };
}

/**
 * A variable that is optional because of `oneOf` still needs at least one member
 * present. Groups are evaluated per environment, not globally: `NEON_AUTH_ISSUER`
 * existing in staging says nothing about prod.
 */
export function requirementGroups(env: EnvName): Map<string, VariableSpec[]> {
  const groups = new Map<string, VariableSpec[]>();
  for (const variable of VARIABLES) {
    if (!variable.oneOf) continue;
    if (!variable.requiredIn.includes(env) && !(variable.recommendedIn ?? []).includes(env)) {
      continue;
    }
    const members = groups.get(variable.oneOf) ?? [];
    members.push(variable);
    groups.set(variable.oneOf, members);
  }
  return groups;
}

/**
 * What `secrets:sync` will push for one environment.
 *
 * Only variables that are *required or recommended* in this environment and that
 * appear in the env file are candidates: syncing an optional variable the operator
 * happened to leave in their file would push a staging-only default into production.
 */
export function syncableVariables(env: EnvName): VariableSpec[] {
  return VARIABLES.filter(
    (variable) =>
      !variable.planned &&
      (variable.requiredIn.includes(env) ||
        (variable.recommendedIn ?? []).includes(env) ||
        // Pipeline plumbing (the Vercel token, the smoke target) is not something the
        // app needs to boot, so it must not fail `check:readiness` — but if it is in
        // the file it is exactly what `secrets:sync` exists to place.
        variable.consumer === "ci"),
  );
}

/** The GitHub Environment a deployment binds to. `prod` is named `production`. */
export function githubEnvironmentFor(env: EnvName): string {
  return env === "prod" ? "production" : env;
}
