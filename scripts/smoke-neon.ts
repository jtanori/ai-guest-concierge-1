#!/usr/bin/env node
/**
 * W00 — Neon smoke: proves all four provisioned services end to end.
 *
 * Run: npm run smoke:neon    (expects .env.local from `neon deploy`)
 *
 * Checks (each is a real round-trip, not a config read):
 *   1. Postgres    — SELECT version(); neon_auth schema present
 *   2. Auth        — base URL reachable; JWKS has ≥1 key
 *   3. Storage     — PUT object → GET it back byte-identical → DELETE
 *   4. Functions   — invoke the hello function over HTTPS
 *
 * Exits non-zero if any check fails. Never prints credential values.
 */
import { postgresStatus, closePool } from "../src/neon/postgres.ts";
import { authStatus, neonAuthSchemaPresent } from "../src/neon/auth.ts";
import {
  getS3Client,
  putObject,
  getObject,
  listObjectKeys,
  deleteObject,
  NEON_BUCKET_ASSETS,
  NEON_SMOKE_PREFIX,
} from "../src/neon/storage.ts";
import { invokeHello } from "../src/neon/functions.ts";

let failed = 0;
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  if (!ok) failed++;
};

// 1. Postgres — the real database on this branch
try {
  const status = await postgresStatus();
  const major = /PostgreSQL (\d+)/.exec(status.serverVersion)?.[1] ?? "?";
  const authSchema = await neonAuthSchemaPresent();
  verdict(
    "postgres",
    (status.currentDatabase?.length ?? 0) > 0 && authSchema,
    `v${major} · db=${status.currentDatabase} · available: ` +
      `${status.availableExtensions.join(", ") || "none"} · neon_auth schema: ${authSchema}`,
  );
} catch (error) {
  verdict("postgres", false, (error as Error).message);
}

// 2. Neon Auth — managed Better Auth on this branch
try {
  const status = await authStatus();
  verdict(
    "auth",
    status.baseReachable && status.jwksKeys > 0,
    `base HTTP ${status.baseUrlStatus} · JWKS keys: ${status.jwksKeys}`,
  );
} catch (error) {
  verdict("auth", false, (error as Error).message);
}

// 3. Object Storage — full PUT → GET → DELETE round-trip on the bucket
try {
  const client = getS3Client();
  const key = `${NEON_SMOKE_PREFIX}w00-${Date.now()}.txt`;
  const body = `ai-guest-concierge neon smoke ${new Date().toISOString()}`;
  await putObject(client, NEON_BUCKET_ASSETS, key, body);
  const roundTrip = await getObject(client, NEON_BUCKET_ASSETS, key);
  const listed = await listObjectKeys(client, NEON_BUCKET_ASSETS, NEON_SMOKE_PREFIX);
  const identical = roundTrip === body;
  const listedKey = listed.includes(key);
  await deleteObject(client, NEON_BUCKET_ASSETS, key);
  verdict(
    "storage",
    identical && listedKey,
    `bucket=${NEON_BUCKET_ASSETS} · put→get ${identical ? "identical" : "MISMATCH"} · listed: ${String(listedKey)} · delete: sent`,
  );
} catch (error) {
  verdict("storage", false, (error as Error).message);
}

// 4. Functions — hello endpoint over HTTPS
try {
  const res = await invokeHello();
  verdict(
    "functions",
    res.status === 200 && res.body.length > 0,
    `HTTP ${res.status} · "${res.body.slice(0, 40)}"`,
  );
} catch (error) {
  verdict("functions", false, (error as Error).message);
}

await closePool();
process.exit(failed === 0 ? 0 : 1);
