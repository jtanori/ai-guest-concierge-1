#!/usr/bin/env node
/**
 * W00-13 — `npm run check:env`
 *
 * Validates the deployment matrix against the three-environments rule and
 * exits non-zero on any violation. Run it with real URLs in Phase B:
 *
 *   APP_ENV=staging node -e ...   (or from .env files via your shell)
 *   STAGING_DATABASE_URL=postgres://... PROD_DATABASE_URL=postgres://... npm run check:env
 *
 * With no arguments it runs against values from the environment or .env
 * if present, and reports which variables are missing instead of guessing.
 */
import { resolveDeploymentEnvironments } from "../src/config/env.ts";

const localUrl = process.env["LOCAL_DATABASE_URL"];
const stagingUrl = process.env["STAGING_DATABASE_URL"];
const prodUrl = process.env["PROD_DATABASE_URL"];

try {
  const resolved = resolveDeploymentEnvironments({ localUrl, stagingUrl, prodUrl });
  console.log("OK — no shared databases:");
  console.log(`  staging -> ${mask(resolved.stagingUrl)}`);
  console.log(`  prod    -> ${mask(resolved.prodUrl)}`);
} catch (error) {
  console.error(`check:env FAILED: ${(error as Error).message}`);
  process.exit(1);
}

function mask(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<unparsable>";
  }
}
