#!/usr/bin/env node
/**
 * S01-01 — migration runner.
 *
 * Thin CLI over src/db/migrate.ts (the reusable library the db test suite and
 * CI use on scratch databases).
 *
 *   npm run db:migrate                     (against $DATABASE_URL)
 *   node scripts/migrate.ts --url postgres://...   (override target)
 */
import { migrateDatabase } from "../src/db/migrate.ts";

const urlFlag = (argIndex: number): string | undefined => {
  const arg = process.argv[argIndex];
  return arg === "--url" ? process.argv[argIndex + 1] : undefined;
};

const target = urlFlag(2) ?? process.env["DATABASE_URL"];
if (!target) {
  console.error("migrate: no --url and no DATABASE_URL in environment");
  process.exit(1);
}

const applied = await migrateDatabase(target);
console.log(`migrate: ${applied} applied`);
