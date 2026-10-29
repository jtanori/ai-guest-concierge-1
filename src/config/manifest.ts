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
 * ## Two contracts, deliberately separate
 *
 * The contract has exactly two halves, and conflating them is how a variable's
 * *type* and a stage's *requirements* drift apart:
 *
 *  - **`CORE` — what a variable IS.** Its name, its type (secret or plain), where it
 *    lives (`store`), who reads it (`consumer`), the either/or group it belongs to,
 *    and why it exists. Environment-independent: a credential does not become a
 *    different kind of thing between staging and production.
 *  - **`STAGES` — what one environment REQUIRES.** The per-stage sub-contract: two
 *    lists of names drawn from `CORE`, `required` (missing fails readiness and, the
 *    deployed boot) and `recommended` (missing warns). This is the only place that
 *    knows staging differs from local.
 *
 * A stage sub-contract can only name variables the core contract declares — the
 * module refuses to load otherwise, so a gate can never require a variable that
 * does not exist (the `GEMINI_API_KEY` failure: a gate in `scripts/` and a workflow
 * referenced a name no contract had ever heard of, because nothing connected code
 * reads back to this file). `contract-coverage.test.ts` closes the same hole from
 * the other direction: every env name read in `src/`, `scripts/`, `web/` or any
 * workflow must be declared here.
 *
 * ## Three ideas, kept in their halves
 *
 *  - **required / recommended** live in `STAGES`. Missing from `required` fails the
 *    readiness check and, outside `local`, the boot (see `resolveBootMode`). Missing
 *    from `recommended` is a warning, never a failure — a warning that blocks work is
 *    a warning people learn to bypass.
 *  - **`store`** lives in `CORE` — WHERE the value has to exist for a deployed
 *    environment. A variable can be correct in the repo and absent in the place that
 *    actually deploys it; that is the gap `check-secrets.ts` reports and
 *    `secrets:sync` closes.
 *  - **`secret`** lives in `CORE` — the variable's type. `secrets:sync` writes
 *    `secret: true` with `gh secret set` and `secret: false` with `gh variable set`;
 *    the workflow guards assert every `${{ secrets.X }}` in a workflow is declared
 *    secret and every `${{ vars.X }}` is not.
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
 * `SENTRY_DSN` is declared but never enforced: W00-14 has no reporter wired yet, so
 * requiring it would fail a production deploy over a feature that does not exist.
 * A manifest that demands things it cannot use trains people to ignore it.
 * `TEST_DATABASE_URL` is absent on purpose: it is test-runner plumbing, not a value
 * any environment or pipeline reads.
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

/**
 * The core contract: what one variable IS, in every environment.
 *
 * No `required`/`recommended` here on purpose — those are the stage's business
 * (`STAGES` below). Everything here is a property of the name itself.
 */
export interface CoreVariable {
  name: string;
  consumer: Consumer;
  /** Never printed, never logged, never in a report — and synced with `gh secret set`. */
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
   * "not enforced" rather than silently counted as optional, and the module
   * refuses to put a planned variable in any stage's `required` list.
   */
  planned?: boolean;
}

/**
 * One environment's sub-contract: which core variables this stage needs, and how
 * loudly. Every name referenced here must exist in `CORE` — validated at module
 * load, so a typo fails every script and test that imports the contract instead of
 * quietly requiring nothing.
 */
export interface StageContract {
  /** Missing → readiness error; outside `local`, boot failure. */
  required: readonly string[];
  /** Missing → warning. Never blocking. */
  recommended: readonly string[];
}

export interface VariableSpec extends CoreVariable {
  /** Environments whose stage sub-contract lists this name as required. Derived. */
  requiredIn: readonly EnvName[];
  /** Environments whose stage sub-contract lists this name as recommended. Derived. */
  recommendedIn?: readonly EnvName[];
}

const ENVIRONMENTS: readonly EnvName[] = ["local", "staging", "prod"];

export const CORE: readonly CoreVariable[] = [
  {
    name: "APP_ENV",
    consumer: "api",
    secret: false,
    store: "process",
    why: "selects the whole config matrix; an unset value defaults to local, which is the one environment that tolerates everything else being missing",
  },
  {
    name: "DATABASE_URL",
    consumer: "api",
    secret: true,
    store: "github-environment",
    why: "every environment points at its own database; the deploy job runs migrations with the value from its own GitHub Environment",
  },
  {
    name: "LOG_LEVEL",
    consumer: "api",
    secret: false,
    store: "process",
    why: "defaults to debug locally and info elsewhere; set it to quiet a noisy host",
  },
  {
    name: "APP_NAME",
    consumer: "api",
    secret: false,
    store: "process",
    why: "defaulted; only set it to distinguish two deployments in one log sink",
  },
  {
    name: "NEON_AUTH_JWKS_URL",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "staff tokens cannot be verified without it, so every staff route answers 503",
  },
  {
    name: "NEON_AUTH_ISSUER",
    consumer: "api",
    secret: false,
    oneOf: "auth-issuer",
    store: "github-environment",
    why: "token issuer check; falls back to NEON_AUTH_BASE_URL",
  },
  {
    name: "NEON_AUTH_BASE_URL",
    consumer: "api",
    secret: false,
    oneOf: "auth-issuer",
    store: "github-environment",
    why: "doubles as the issuer when NEON_AUTH_ISSUER is unset",
  },
  {
    name: "NEON_AUTH_AUDIENCE",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "defaulted to the issuer; override only if the branch's tokens carry a different audience",
  },
  {
    name: "GUEST_COOKIE_SECRET",
    consumer: "api",
    secret: true,
    store: "github-environment",
    why: "signs the anonymous guest identity cookie; a default would be a published signing key",
  },
  {
    name: "GUEST_PUBLIC_URL",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "the bare origin a QR code encodes; unset, a printed card points at an internal hostname",
  },
  {
    name: "LLM_PRIMARY_MODEL",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "the pinned model id; never defaulted, because a floating alias is a different model in six months",
  },
  {
    name: "LLM_FALLBACK_MODEL",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "the second pinned model; the same id twice is the same failure twice",
  },
  {
    name: "LLM_API_KEY",
    consumer: "api",
    secret: true,
    store: "github-environment",
    why: "without it the host cannot answer a single guest message",
  },
  {
    name: "LLM_BASE_URL",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "defaulted to the Gemini endpoint",
  },
  {
    name: "LLM_TIMEOUT_MS",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "defaulted to 8s; bounded by the guest's patience, not by a vendor's SLA",
  },
  {
    name: "LLM_RETRIES",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "defaulted to two; the ceiling is four because the guest is the one waiting",
  },
  {
    name: "EMBEDDING_API_KEY",
    consumer: "api",
    secret: true,
    store: "github-environment",
    why: "the vector branch of retrieval; without it the product answers from lexical + trigram only",
  },
  {
    name: "EMBEDDING_MODEL",
    consumer: "api",
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
    secret: false,
    store: "github-environment",
    why: "per-request timeout for the embedding provider; 20000 by default",
  },
  {
    name: "EMBEDDING_BATCH_SIZE",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "chunks per embedding request, 1..128; 16 by default",
  },
  {
    name: "EMBEDDING_BASE_URL",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "defaulted to the OpenAI endpoint",
  },
  {
    name: "TURNSTILE_SECRET",
    consumer: "api",
    secret: true,
    store: "github-environment",
    why: "the bot check on the first guest message; a control that is on only if someone remembered is off",
  },
  {
    name: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    consumer: "web",
    secret: false,
    store: "vercel",
    why: "without the site key no widget renders, so the server's bot check has no token to verify",
  },
  {
    name: "EMAIL_FROM",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "the escalation sender; a default would be a published address every deployment shares",
  },
  {
    name: "EMAIL_API_KEY",
    consumer: "api",
    secret: true,
    store: "github-environment",
    why: "the provider key; without it a queued escalation is a row nobody sends",
  },
  {
    name: "EMAIL_ESCALATION_FALLBACK",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "where a request goes when the property configured no contacts; no default exists on purpose",
  },
  {
    name: "CONSOLE_BASE_URL",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "builds the link in every escalation email; the local default points recipients at their own machine",
  },
  {
    name: "REVIEW_API_URL",
    consumer: "web",
    secret: false,
    store: "vercel",
    why: "the only address the staff screen calls, from the Next server, never the browser",
  },
  {
    // S07-05's outage switch. Refusing it in prod is enforced in code, not here:
    // this entry exists so the variable is documented and not required anywhere.
    name: "AI_FAIL_MODE",
    consumer: "api",
    secret: false,
    store: "process",
    why: "none | once | always — turns an AI outage into an input; refused when APP_ENV=prod",
  },
  {
    name: "TURNSTILE_TIMEOUT_MS",
    consumer: "api",
    secret: false,
    store: "github-environment",
    why: "how long the bot check waits before treating the check as unavailable; 3000 by default",
  },
  {
    name: "SENTRY_DSN",
    consumer: "api",
    secret: true,
    store: "github-environment",
    planned: true,
    why: "W00-14 error tracking — listed so the gap is visible, not enforced until a reporter is wired",
  },
  {
    name: "ALLOW_DEGRADED_BOOT",
    consumer: "api",
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
    secret: true,
    store: "github-repo",
    why: "deploys the Vercel surface; one token for one project, so it is repo-level and not per-environment",
  },
  {
    name: "VERCEL_ORG_ID",
    consumer: "ci",
    secret: false,
    store: "github-repo",
    why: "identifies the Vercel team; identical across environments",
  },
  {
    name: "VERCEL_PROJECT_ID",
    consumer: "ci",
    secret: false,
    store: "github-repo",
    why: "identifies the API Vercel project; identical across environments",
  },
  {
    name: "VERCEL_WEB_PROJECT_ID",
    consumer: "ci",
    secret: false,
    store: "github-repo",
    why: "identifies the web tier's Vercel project; web-consumer vercel-store variables route here, not to the API project",
  },
  // ── platform plumbing: read by src/server.ts, declared so the contract (and the
  // coverage test) can see them. None is required by any stage yet: no environment
  // runs `src/server.ts` — hosting is issue #153 — and every reader below defaults
  // or fails at its own route, not at boot. When a host lands, its stage sub-contract
  // adopts them instead of this section growing a second source of truth.
  {
    name: "HOST",
    consumer: "api",
    secret: false,
    store: "process",
    why: "bind address for src/server.ts; defaulted to 127.0.0.1 by the hosting convention",
  },
  {
    name: "PORT",
    consumer: "api",
    secret: false,
    store: "process",
    why: "bind port for src/server.ts; defaulted to 3000 by the hosting convention",
  },
  {
    name: "AWS_ACCESS_KEY_ID",
    consumer: "api",
    secret: true,
    store: "process",
    why: "half of the credential pair for the asset bucket; /healthz/storage and the asset routes throw StorageEnvError without it",
  },
  {
    name: "AWS_SECRET_ACCESS_KEY",
    consumer: "api",
    secret: true,
    store: "process",
    why: "the other half of that pair; stored wherever its host stores credentials, never printed",
  },
  {
    name: "AWS_REGION",
    consumer: "api",
    secret: false,
    store: "process",
    why: "region of the asset bucket; not secret, but the S3 client refuses to guess",
  },
  {
    name: "AWS_ENDPOINT_URL_S3",
    consumer: "api",
    secret: false,
    store: "process",
    why: "S3-compatible endpoint (Neon's asset storage); the client refuses to guess a vendor",
  },
  {
    name: "NEON_FUNCTION_HELLO_BASE_URL",
    consumer: "api",
    secret: false,
    store: "process",
    why: "the Neon Function /healthz/function probes; missing, that probe reports the failure honestly",
  },
  {
    name: "SMOKE_PROPERTY_SLUG",
    consumer: "ci",
    secret: false,
    store: "process",
    why: "which property `npm run smoke` scores; defaulted to demo",
  },
];

/**
 * The per-environment sub-contracts. Every name must exist in `CORE`, must not
 * appear in both lists of one stage, and a `planned` variable must appear in
 * neither — all three invariants are checked when this module loads, and again in
 * `contract-coverage.test.ts` with readable failures.
 */
export const STAGES: Readonly<Record<EnvName, StageContract>> = {
  local: {
    required: ["DATABASE_URL", "LLM_PRIMARY_MODEL", "LLM_FALLBACK_MODEL", "EMAIL_FROM"],
    recommended: [
      "APP_ENV",
      "NEON_AUTH_JWKS_URL",
      "NEON_AUTH_ISSUER",
      "NEON_AUTH_BASE_URL",
      "GUEST_COOKIE_SECRET",
      "LLM_API_KEY",
      "EMBEDDING_API_KEY",
      "EMAIL_API_KEY",
      "REVIEW_API_URL",
    ],
  },
  staging: {
    required: [
      "APP_ENV",
      "DATABASE_URL",
      "NEON_AUTH_JWKS_URL",
      "NEON_AUTH_ISSUER",
      "NEON_AUTH_BASE_URL",
      "GUEST_COOKIE_SECRET",
      "GUEST_PUBLIC_URL",
      "LLM_PRIMARY_MODEL",
      "LLM_FALLBACK_MODEL",
      "LLM_API_KEY",
      "EMBEDDING_API_KEY",
      "TURNSTILE_SECRET",
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      "EMAIL_FROM",
      "EMAIL_API_KEY",
      "EMAIL_ESCALATION_FALLBACK",
      "CONSOLE_BASE_URL",
      "REVIEW_API_URL",
    ],
    recommended: [],
  },
  prod: {
    // Prod is exactly as strict as staging — no stricter, no looser. Prod being
    // stricter is how a deploy passes every rehearsal and fails on the night.
    required: [
      "APP_ENV",
      "DATABASE_URL",
      "NEON_AUTH_JWKS_URL",
      "NEON_AUTH_ISSUER",
      "NEON_AUTH_BASE_URL",
      "GUEST_COOKIE_SECRET",
      "GUEST_PUBLIC_URL",
      "LLM_PRIMARY_MODEL",
      "LLM_FALLBACK_MODEL",
      "LLM_API_KEY",
      "EMBEDDING_API_KEY",
      "TURNSTILE_SECRET",
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      "EMAIL_FROM",
      "EMAIL_API_KEY",
      "EMAIL_ESCALATION_FALLBACK",
      "CONSOLE_BASE_URL",
      "REVIEW_API_URL",
    ],
    recommended: [],
  },
};

// ── Load-time validation. A stage that names a variable the core contract does not
// declare is the exact failure class this file exists to prevent: the check would
// gate on a name nothing reads, or require a name no loader knows. Failing at import
// beats failing at 3 a.m.
function validateContracts(): void {
  const coreByName = new Map(CORE.map((variable) => [variable.name, variable]));
  if (coreByName.size !== CORE.length) {
    throw new Error("contract: CORE declares the same variable name twice");
  }
  for (const [env, stage] of Object.entries(STAGES)) {
    const required = new Set(stage.required);
    if (required.size !== stage.required.length) {
      throw new Error(`contract: STAGES.${env}.required names a variable twice`);
    }
    for (const name of stage.required) {
      const core = coreByName.get(name);
      if (core === undefined) {
        throw new Error(
          `contract: STAGES.${env}.required names "${name}", which CORE does not declare`,
        );
      }
      if (core.planned === true) {
        throw new Error(
          `contract: STAGES.${env}.required demands "${name}", which is planned and not enforced anywhere`,
        );
      }
    }
    const seen = new Set(required);
    if (new Set(stage.recommended).size !== stage.recommended.length) {
      throw new Error(`contract: STAGES.${env}.recommended names a variable twice`);
    }
    for (const name of stage.recommended) {
      const core = coreByName.get(name);
      if (core === undefined) {
        throw new Error(
          `contract: STAGES.${env}.recommended names "${name}", which CORE does not declare`,
        );
      }
      if (seen.has(name)) {
        throw new Error(
          `contract: STAGES.${env} lists "${name}" as both required and recommended`,
        );
      }
      seen.add(name);
    }
  }
}
validateContracts();

/**
 * The joined view: core facts + the stages that demand them. This is what every
 * consumer — readiness, sync, audit, the workflow guards — has always read, kept as
 * the derived projection of the two contracts so no caller needs to know about the
 * split. `requiredIn`/`recommendedIn` are computed from `STAGES`; editing a stage
 * list is the only way to change them.
 */
export const VARIABLES: readonly VariableSpec[] = CORE.map((core) => {
  const requiredIn = ENVIRONMENTS.filter((env) => STAGES[env].required.includes(core.name));
  const recommendedIn = ENVIRONMENTS.filter((env) =>
    STAGES[env].recommended.includes(core.name),
  );
  return {
    ...core,
    requiredIn,
    ...(recommendedIn.length > 0 ? { recommendedIn } : {}),
  };
});

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
