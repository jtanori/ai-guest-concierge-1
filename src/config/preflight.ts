/**
 * W00-13 — environment readiness, checked through the loaders that actually run.
 *
 * The point of this module is that it does **not** re-implement validation. A
 * readiness check with its own rules is worse than none: it goes green while the
 * process it is meant to predict refuses to boot, and the first person to find out
 * is a guest. So every rule that exists in `loadConfig`, `loadLlmConfig`,
 * `loadEmailConfig`, `loadGuestConfig`, `loadBotCheckConfig` or `loadAuthConfig` is
 * exercised by calling it.
 *
 * The manifest supplies what those loaders cannot: which variables are required in
 * *this* environment, and which of them are secrets that must never appear in a
 * report.
 */
import { ConfigError, isEnvName, loadConfig, loadEmbeddingConfig, loadLlmConfig, resolveDeploymentEnvironments, type EnvName } from "./env.ts";
import {
  VARIABLES,
  VARIABLE_BY_NAME,
  requirementGroups,
  type Consumer,
  type VariableSpec,
} from "./manifest.ts";
import { loadAuthConfig } from "../auth/session.ts";
import { loadEmailConfig } from "../notifications/email.ts";
import { loadGuestConfig } from "../guest/cookie.ts";
import { loadBotCheckConfig } from "../security/botcheck.ts";

export type Severity = "error" | "warning";

export interface Finding {
  variable: string;
  severity: Severity;
  message: string;
}

export interface PresentVariable {
  name: string;
  /** `set` for a secret — never the value. */
  shown: string;
  secret: boolean;
}

export interface ReadinessReport {
  env: EnvName;
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  present: PresentVariable[];
  /** Names required in this environment that are absent. */
  missing: string[];
}

/**
 * What a secret looks like in a report. Deliberately not "the last four": a
 * readiness report gets pasted into an issue, and four characters of a live key is
 * a fact about that key that survives in a public place forever.
 */
export function maskSecret(spec: VariableSpec, value: string): string {
  if (spec.secret) return value === "" ? "<empty>" : "set";
  return value;
}

/**
 * Remove any secret value that leaked into a loader's message.
 *
 * The loaders are careful, but they are not written with a reporting context in
 * mind, and one of them interpolates a value (`got "${baseUrl}"`). Rather than
 * trusting every future loader to be careful, every message passes through here,
 * and a test asserts that a secret planted in a config error never reaches the
 * report.
 */
export function scrubSecrets(message: string, source: Record<string, string | undefined>): string {
  let scrubbed = message;
  for (const variable of VARIABLES) {
    if (!variable.secret) continue;
    const value = (source[variable.name] ?? "").trim();
    // Short values are not secrets in any meaningful sense, and replacing a
    // two-character value would mangle ordinary words ("on", "id").
    if (value.length < 8) continue;
    scrubbed = scrubbed.split(value).join("[redacted]");
  }
  return scrubbed;
}

/** Values that look like a placeholder rather than a configured secret. */
const PLACEHOLDER = /^(changeme|change-me|todo|xxx+|placeholder|secret|test|example|your[-_]?.*|<.*>)$/i;

function checkPlaceholders(
  source: Record<string, string | undefined>,
  env: EnvName,
): Finding[] {
  const findings: Finding[] = [];
  for (const variable of VARIABLES) {
    if (!variable.secret) continue;
    if (!variable.requiredIn.includes(env)) continue;
    const value = (source[variable.name] ?? "").trim();
    if (value === "") continue;
    if (PLACEHOLDER.test(value)) {
      findings.push({
        variable: variable.name,
        severity: "error",
        message: "looks like a placeholder, not a configured secret",
      });
    }
  }
  return findings;
}

/**
 * Run one loader and turn its first failure into a finding.
 *
 * `variable` is who to blame when the loader's own message does not name one — the
 * loaders are consistent about naming their variables, but a future one might not.
 */
function runLoader(
  variable: string,
  load: () => unknown,
  env: EnvName,
): Finding[] {
  try {
    load();
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Longest match wins: `LLM_API_KEY` must beat `APP_ENV` in a message that
    // mentions both, and the loader's own subject is usually the longest name.
    const blamed =
      VARIABLES.map((v) => v.name)
        .filter((name) => message.includes(name))
        .sort((a, b) => b.length - a.length)[0] ?? variable;
    const spec = VARIABLE_BY_NAME.get(blamed);
    const severity: Severity = spec?.requiredIn.includes(env) ? "error" : "warning";
    return [{ variable: blamed, severity, message }];
  }
}

/**
 * The whole readiness check for one environment.
 *
 * Order matters only for readability; every check runs even after one fails, because
 * a report that names all seven missing variables is one round trip for the operator
 * instead of seven.
 */
export function checkReadiness(
  source: Record<string, string | undefined>,
  env: EnvName,
  options: { consumer?: Consumer } = {},
): ReadinessReport {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const push = (finding: Finding): void => {
    if (finding.severity === "error") errors.push(finding);
    else warnings.push(finding);
  };

  // 1. The file must describe the environment it is being checked as. A
  //    `.env.staging` carrying APP_ENV=local is the single most likely way to
  //    "verify" staging while actually verifying a developer's shell.
  const declared = source["APP_ENV"];
  if (declared !== undefined && declared !== env) {
    push({
      variable: "APP_ENV",
      severity: "error",
      message: `the file declares APP_ENV=${declared} but is being checked as ${env}`,
    });
  }

  // 2. Hard requirements from the manifest.
  for (const variable of VARIABLES) {
    if (!variable.requiredIn.includes(env)) continue;
    if (variable.oneOf) continue; // groups are evaluated below
    const value = (source[variable.name] ?? "").trim();
    if (value === "") {
      push({
        variable: variable.name,
        severity: "error",
        message: `required in ${env} and absent — ${variable.why}`,
      });
    }
  }

  // 3. One-of groups: at least one member must be present.
  for (const [group, members] of requirementGroups(env)) {
    const anyPresent = members.some((member) => (source[member.name] ?? "").trim() !== "");
    if (anyPresent) continue;
    const required = members.some((member) => member.requiredIn.includes(env));
    push({
      variable: members.map((member) => member.name).join(" | "),
      severity: required ? "error" : "warning",
      message:
        `one of these is${required ? "" : " recommended"} in ${env} (${group}): ` +
        members[0]!.why,
    });
  }

  // 4. Recommendations — local only, by construction, and never blocking.
  for (const variable of VARIABLES) {
    if (!(variable.recommendedIn ?? []).includes(env)) continue;
    if (variable.requiredIn.includes(env)) continue;
    if ((source[variable.name] ?? "").trim() === "") {
      push({
        variable: variable.name,
        severity: "warning",
        message: `not set — the surface that needs it will answer 503 (${variable.why})`,
      });
    }
  }

  // 5. The loaders that will actually run.
  for (const finding of runLoader("APP_ENV", () => loadConfig(source), env)) push(finding);
  for (const finding of runLoader("LLM_PRIMARY_MODEL", () => loadLlmConfig(source, env), env)) {
    push(finding);
  }
  for (const finding of runLoader("GUEST_COOKIE_SECRET", () => loadGuestConfig(source), env)) {
    push(finding);
  }
  for (const finding of runLoader("TURNSTILE_SECRET", () => loadBotCheckConfig(source, env), env)) {
    push(finding);
  }
  for (const finding of runLoader("NEON_AUTH_JWKS_URL", () => loadAuthConfig(source), env)) {
    push(finding);
  }

  // Embeddings are optional by design (`buildEmbedder` returns undefined without a
  // key), so a failure here is only an error when the manifest says the key is
  // required — which is what `runLoader` already decides.
  for (const finding of runLoader("EMBEDDING_API_KEY", () => loadEmbeddingConfig(source), env)) {
    push(finding);
  }

  // Email is required everywhere (EMAIL_FROM has no default), but local runs in
  // `log` mode without a key. The loader encodes that; this only reports it.
  for (const finding of runLoader("EMAIL_FROM", () => loadEmailConfig(source, env), env)) {
    push(finding);
  }

  // 6. Placeholders are not configuration.
  for (const finding of checkPlaceholders(source, env)) push(finding);

  // 7. S07-05's refusal, checked here too so a deploy fails before the process does.
  const chaos = (source["AI_FAIL_MODE"] ?? "").trim().toLowerCase();
  if (env === "prod" && chaos !== "" && chaos !== "none") {
    push({
      variable: "AI_FAIL_MODE",
      severity: "error",
      message: `must not be set to "${chaos}" in prod — a host that can be made to fail its AI by an env var is a host where one copied file is an outage`,
    });
  }

  // 8. The deployment matrix, when all three legs are present. Absent legs are not
  //    an error here: a single environment is often checked on its own.
  const stagingUrl = source["STAGING_DATABASE_URL"];
  const prodUrl = source["PROD_DATABASE_URL"];
  if (stagingUrl !== undefined && prodUrl !== undefined) {
    try {
      resolveDeploymentEnvironments({
        localUrl: source["LOCAL_DATABASE_URL"],
        stagingUrl,
        prodUrl,
      });
    } catch (error) {
      push({
        variable: "STAGING_DATABASE_URL | PROD_DATABASE_URL",
        severity: "error",
        message: error instanceof ConfigError ? error.message : String(error),
      });
    }
  }

  const present: PresentVariable[] = VARIABLES.filter(
    (variable) => (source[variable.name] ?? "").trim() !== "",
  ).map((variable) => ({
    name: variable.name,
    shown: maskSecret(variable, (source[variable.name] ?? "").trim()),
    secret: variable.secret,
  }));

  const missing = VARIABLES.filter(
    (variable) =>
      variable.requiredIn.includes(env) &&
      !variable.oneOf &&
      (source[variable.name] ?? "").trim() === "",
  ).map((variable) => variable.name);

  // A consumer filter changes which findings are FATAL, never which are found: the
  // API deploy must not fail over a Next.js-only variable, and it must not pretend
  // that variable is fine either.
  if (options.consumer !== undefined) {
    const consumerOf = (name: string): Consumer | undefined =>
      VARIABLE_BY_NAME.get(name)?.consumer;
    const forConsumer = (finding: Finding): boolean =>
      finding.variable
        .split(" | ")
        .some((name) => consumerOf(name.trim()) === options.consumer);
    const kept = errors.filter(forConsumer);
    const downgraded = errors.filter((finding) => !forConsumer(finding));
    // Clear and re-add ONLY the downgraded ones. The first version emptied the
    // array and pushed back the non-matching findings, which deleted every finding
    // that belonged to the consumer — a strict staging host then booted happily
    // because its readiness report was empty. Caught by starting the server, not by
    // reading the code.
    errors.length = 0;
    errors.push(...kept);
    warnings.push(...downgraded);
  }

  // One finding per variable, first wins. The manifest's "required and absent"
  // explains the consequence; the loader's "is required" is the same fact twice.
  const seen = new Set<string>();
  const namesOf = (finding: Finding): string[] =>
    finding.variable.split(" | ").map((name) => name.trim());
  const dedupe = (findings: Finding[]): Finding[] =>
    findings.filter((finding) => {
      const names = namesOf(finding);
      if (names.some((name) => seen.has(name))) return false;
      for (const name of names) seen.add(name);
      return true;
    });
  const dedupedErrors = dedupe(errors);
  const dedupedWarnings = dedupe(warnings);

  // Scrub last, so nothing above had to remember to.
  const scrubbedErrors = dedupedErrors.map((finding) => ({
    ...finding,
    message: scrubSecrets(finding.message, source),
  }));
  const scrubbedWarnings = dedupedWarnings.map((finding) => ({
    ...finding,
    message: scrubSecrets(finding.message, source),
  }));

  return {
    env,
    ok: scrubbedErrors.length === 0,
    errors: scrubbedErrors,
    warnings: scrubbedWarnings,
    present,
    missing,
  };
}

/** Resolve the environment to check, refusing anything that is not one of the three. */
export function resolveCheckEnv(raw: string | undefined): EnvName {
  if (raw === undefined) return "local";
  if (!isEnvName(raw)) {
    throw new ConfigError(`--env must be one of local | staging | prod, got "${raw}"`);
  }
  return raw;
}
