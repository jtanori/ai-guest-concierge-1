#!/usr/bin/env node
import pg from "pg";
import { seedDemo } from "../src/seed/demo.ts";

if (process.env["APP_ENV"] === "prod") {
  console.error("seed: refusing to run with APP_ENV=prod");
  process.exit(1);
}

const urlFlag = (argIndex: number): string | undefined => {
  const arg = process.argv[argIndex];
  return arg === "--url" ? process.argv[argIndex + 1] : undefined;
};

const target = urlFlag(2) ?? process.env["DATABASE_URL"];
if (!target) {
  console.error("seed: no --url and no DATABASE_URL in environment");
  process.exit(1);
}

const client = new pg.Client({ connectionString: target });
await client.connect();

try {
  await client.query("BEGIN");
  const summary = await seedDemo(client);
  await client.query("COMMIT");
  console.log(JSON.stringify(summary));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
