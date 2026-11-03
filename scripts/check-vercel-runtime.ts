#!/usr/bin/env node
/**
 * scripts/check-vercel-runtime.ts
 *
 * Audits that the Vercel project has all required runtime environment variables
 * configured for serverless Function execution in preview/staging and production.
 *
 * Key guarantees:
 *  - Requests metadata only (never passes decrypt=true).
 *  - Never logs or exposes secret values.
 *  - Checks target scope (preview vs production) and branch binding (e.g. gitBranch: "staging").
 *  - Fails closed: if Vercel API cannot be reached or returns an error, exits with code 1.
 */
import process from "node:process";

export interface VercelEnvMetadata {
  key: string;
  target: string[];
  gitBranch?: string | null;
  type?: string;
}

export interface VercelAuditResult {
  env: "staging" | "prod";
  projectId: string;
  ok: boolean;
  missing: string[];
  present: string[];
  warnings: string[];
  error?: string;
}

// Required runtime variables for the API surface (from src/config/manifest.ts)
export const REQUIRED_API_RUNTIME_VARS = [
  "APP_ENV",
  "DATABASE_URL",
  "GUEST_COOKIE_SECRET",
  "GUEST_PUBLIC_URL",
  "LLM_PRIMARY_MODEL",
  "LLM_FALLBACK_MODEL",
  "LLM_API_KEY",
  "TURNSTILE_SECRET",
  "NEON_AUTH_JWKS_URL",
  "EMAIL_FROM",
  "EMAIL_API_KEY",
  "EMAIL_ESCALATION_FALLBACK",
  "CONSOLE_BASE_URL",
] as const;

// Auth issuer one-of group (at least one must be present)
export const AUTH_ISSUER_GROUP = ["NEON_AUTH_ISSUER", "NEON_AUTH_BASE_URL"] as const;

export async function fetchVercelEnvMetadata(
  projectId: string,
  token: string,
  teamId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VercelEnvMetadata[]> {
  const url = new URL(`https://api.vercel.com/v9/projects/${projectId}/env`);
  if (teamId) url.searchParams.set("teamId", teamId);
  // Deliberately DO NOT set decrypt=true. Metadata only.

  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vercel API error HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    envs?: Array<{
      key?: string;
      target?: string[] | string;
      gitBranch?: string | null;
      type?: string;
    }>;
  };

  const results: VercelEnvMetadata[] = [];
  for (const entry of data.envs ?? []) {
    if (!entry.key) continue;
    const target = Array.isArray(entry.target)
      ? entry.target
      : [entry.target ?? "production"];
    results.push({
      key: entry.key,
      target,
      gitBranch: entry.gitBranch ?? null,
      type: entry.type,
    });
  }

  return results;
}

export function auditVercelRuntime(
  env: "staging" | "prod",
  projectId: string,
  envs: VercelEnvMetadata[],
): VercelAuditResult {
  const targetScope = env === "prod" ? "production" : "preview";
  const branchScope = env === "staging" ? "staging" : null;

  // Filter envs applicable to this target
  const applicableKeys = new Set<string>();
  for (const item of envs) {
    if (!item.target.includes(targetScope)) continue;
    // For preview, if gitBranch is specified, it must match or be unbound (general preview)
    if (targetScope === "preview" && item.gitBranch && branchScope && item.gitBranch !== branchScope) {
      continue;
    }
    applicableKeys.add(item.key);
  }

  const missing: string[] = [];
  const present: string[] = [];
  const warnings: string[] = [];

  for (const req of REQUIRED_API_RUNTIME_VARS) {
    if (applicableKeys.has(req)) {
      present.push(req);
    } else {
      missing.push(req);
    }
  }

  // Check auth issuer group (one-of)
  const hasIssuer = AUTH_ISSUER_GROUP.some((k) => applicableKeys.has(k));
  if (hasIssuer) {
    const found = AUTH_ISSUER_GROUP.filter((k) => applicableKeys.has(k));
    present.push(found.join(" | "));
  } else {
    missing.push(`oneOf(${AUTH_ISSUER_GROUP.join(" | ")})`);
  }

  // Check optional embedding key
  if (!applicableKeys.has("EMBEDDING_API_KEY")) {
    warnings.push("EMBEDDING_API_KEY is not configured (Function will use lexical + trigram retrieval)");
  } else {
    present.push("EMBEDDING_API_KEY");
  }

  return {
    env,
    projectId,
    ok: missing.length === 0,
    missing,
    present,
    warnings,
  };
}

function parseCliArgs(argv: string[]) {
  let env: "staging" | "prod" = "staging";
  let projectId = process.env.VERCEL_PROJECT_ID;
  let token = process.env.VERCEL_TOKEN;
  let teamId = process.env.VERCEL_ORG_ID;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--env" && argv[i + 1]) {
      const val = argv[++i]!;
      if (val === "staging" || val === "prod") env = val;
      else throw new Error(`Invalid --env: ${val}. Must be staging or prod.`);
    } else if (arg === "--project" && argv[i + 1]) {
      projectId = argv[++i]!;
    } else if (arg === "--token" && argv[i + 1]) {
      token = argv[++i]!;
    } else if (arg === "--team" && argv[i + 1]) {
      teamId = argv[++i]!;
    }
  }

  return { env, projectId, token, teamId };
}

async function cli() {
  const { env, projectId, token, teamId } = parseCliArgs(process.argv);

  if (!projectId) {
    console.error("ERROR: Missing VERCEL_PROJECT_ID (pass --project or set env var)");
    process.exit(1);
  }
  if (!token) {
    console.error("ERROR: Missing VERCEL_TOKEN (pass --token or set env var)");
    process.exit(1);
  }

  console.log(`Auditing Vercel runtime configuration for environment "${env}" (project ${projectId})...`);

  try {
    const metadata = await fetchVercelEnvMetadata(projectId, token, teamId);
    const result = auditVercelRuntime(env, projectId, metadata);

    console.log(`Verdict: ${result.ok ? "COMPLETE" : "GAPS DETECTED"}`);
    console.log("\nConfigured Runtime Variables (Metadata only):");
    for (const p of result.present) {
      console.log(`  ✓ ${p}`);
    }

    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const w of result.warnings) {
        console.log(`  ! ${w}`);
      }
    }

    if (result.missing.length > 0) {
      console.error("\nMissing Required Vercel Runtime Variables:");
      for (const m of result.missing) {
        console.error(`  ✗ ${m}`);
      }
      process.exit(1);
    }

    console.log("\nVercel runtime configuration audit passed.");
    process.exit(0);
  } catch (err) {
    console.error(`FAIL CLOSED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Run CLI when executed directly
if (process.argv[1]?.endsWith("check-vercel-runtime.ts") || process.argv[1]?.endsWith("check-vercel-runtime.js")) {
  cli();
}
