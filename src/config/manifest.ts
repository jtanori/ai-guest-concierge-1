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
 *  - **`home`** — WHERE the value has to exist for a deployed environment (GitHub
 *    Actions secrets, Vercel environment variables, or the process environment the
 *    platform injects). A variable can be correct in the repo and absent in the
 *    place that actually deploys it; that is the gap `check-secrets.ts` looks for.
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

/** Where the value must live for a deployed environment. */
export type Home = "github-secret" | "vercel-env" | "process-env";

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
  home?: Home;
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
    home: "process-env",
    why: "selects the whole config matrix; an unset value defaults to local, which is the one environment that tolerates everything else being missing",
  },
  {
    name: "DATABASE_URL",
    consumer: "api",
    requiredIn: ALL,
    secret: true,
    home: "process-env",
    why: "every environment points at its own database; nothing boots without one",
  },
  {
    name: "LOG_LEVEL",
    consumer: "api",
    requiredIn: [],
    secret: false,
    home: "process-env",
    why: "defaults to debug locally and info elsewhere; set it to quiet a noisy host",
  },
  {
    name: "APP_NAME",
    consumer: "api",
    requiredIn: [],
    secret: false,
    why: "defaulted; only set it to distinguish two deployments in one log sink",
  },
  {
    name: "NEON_AUTH_JWKS_URL",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: false,
    home: "process-env",
    why: "staff tokens cannot be verified without it, so every staff route answers 503",
  },
  {
    name: "NEON_AUTH_ISSUER",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: false,
    oneOf: "auth-issuer",
    home: "process-env",
    why: "token issuer check; falls back to NEON_AUTH_BASE_URL",
  },
  {
    name: "NEON_AUTH_BASE_URL",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: false,
    oneOf: "auth-issuer",
    home: "process-env",
    why: "doubles as the issuer when NEON_AUTH_ISSUER is unset",
  },
  {
    name: "NEON_AUTH_AUDIENCE",
    consumer: "api",
    requiredIn: [],
    secret: false,
    why: "defaulted to the issuer; override only if the branch's tokens carry a different audience",
  },
  {
    name: "GUEST_COOKIE_SECRET",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: true,
    home: "github-secret",
    why: "signs the anonymous guest identity cookie; a default would be a published signing key",
  },
  {
    name: "GUEST_PUBLIC_URL",
    consumer: "api",
    requiredIn: DEPLOYED,
    secret: false,
    home: "process-env",
    why: "the bare origin a QR code encodes; unset, a printed card points at an internal hostname",
  },
  {
    name: "LLM_PRIMARY_MODEL",
    consumer: "api",
    requiredIn: ALL,
    secret: false,
    why: "the pinned model id; never defaulted, because a floating alias is a different model in six months",
  },
  {
    name: "LLM_FALLBACK_MODEL",
    consumer: "api",
    requiredIn: ALL,
    secret: false,
    why: "the second pinned model; the same id twice is the same failure twice",
  },
  {
    name: "LLM_API_KEY",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: true,
    home: "github-secret",
    why: "without it the host cannot answer a single guest message",
  },
  {
    name: "LLM_BASE_URL",
    consumer: "api",
    requiredIn: [],
    secret: false,
    why: "defaulted to the Gemini endpoint",
  },
  {
    name: "LLM_TIMEOUT_MS",
    consumer: "api",
    requiredIn: [],
    secret: false,
    why: "defaulted to 8s; bounded by the guest's patience, not by a vendor's SLA",
  },
  {
    name: "LLM_RETRIES",
    consumer: "api",
    requiredIn: [],
    secret: false,
    why: "defaulted to two; the ceiling is four because the guest is the one waiting",
  },
  {
    name: "EMBEDDING_API_KEY",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: true,
    home: "github-secret",
    why: "the vector branch of retrieval; without it the product answers from lexical + trigram only",
  },
  {
    name: "EMBEDDING_MODEL",
    consumer: "api",
    requiredIn: [],
    secret: false,
    why: "defaulted to the model that emits the 1536 dimensions D3 locked",
  },
  {
    name: "EMBEDDING_BASE_URL",
    consumer: "api",
    requiredIn: [],
    secret: false,
    why: "defaulted to the OpenAI endpoint",
  },
  {
    name: "TURNSTILE_SECRET",
    consumer: "api",
    requiredIn: DEPLOYED,
    secret: true,
    home: "github-secret",
    why: "the bot check on the first guest message; a control that is on only if someone remembered is off",
  },
  {
    name: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    consumer: "web",
    requiredIn: DEPLOYED,
    secret: false,
    home: "vercel-env",
    why: "without the site key no widget renders, so the server's bot check has no token to verify",
  },
  {
    name: "EMAIL_FROM",
    consumer: "api",
    requiredIn: ALL,
    secret: false,
    home: "process-env",
    why: "the escalation sender; a default would be a published address every deployment shares",
  },
  {
    name: "EMAIL_API_KEY",
    consumer: "api",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: true,
    home: "github-secret",
    why: "resend's key; without it a queued escalation is a row nobody sends",
  },
  {
    name: "EMAIL_ESCALATION_FALLBACK",
    consumer: "api",
    requiredIn: DEPLOYED,
    secret: false,
    home: "process-env",
    why: "where a request goes when the property configured no contacts; no default exists on purpose",
  },
  {
    name: "CONSOLE_BASE_URL",
    consumer: "api",
    requiredIn: DEPLOYED,
    secret: false,
    home: "process-env",
    why: "builds the link in every escalation email; the local default points recipients at their own machine",
  },
  {
    name: "REVIEW_API_URL",
    consumer: "web",
    requiredIn: DEPLOYED,
    recommendedIn: ["local"],
    secret: false,
    home: "vercel-env",
    why: "the only address the staff screen calls, from the Next server, never the browser",
  },
  {
    name: "SENTRY_DSN",
    consumer: "api",
    requiredIn: [],
    secret: true,
    home: "process-env",
    planned: true,
    why: "W00-14 error tracking — listed so the gap is visible, not enforced until a reporter is wired",
  },
  {
    name: "ALLOW_DEGRADED_BOOT",
    consumer: "api",
    requiredIn: [],
    secret: false,
    home: "process-env",
    why: "staging-only escape hatch for preview hosts; refused outright in prod (see resolveBootMode)",
  },
  {
    name: "STAGING_DATABASE_URL",
    consumer: "deploy",
    requiredIn: [],
    secret: true,
    home: "github-secret",
    why: "the W00-13 gate compares it to prod; the deploy workflow migrates it before deploying",
  },
  {
    name: "PROD_DATABASE_URL",
    consumer: "deploy",
    requiredIn: [],
    secret: true,
    home: "github-secret",
    why: "the W00-13 gate compares it to staging; the deploy workflow migrates it before deploying",
  },
  {
    name: "LOCAL_DATABASE_URL",
    consumer: "deploy",
    requiredIn: [],
    secret: false,
    why: "the third leg of the gate: neither deployed environment may reuse it",
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
