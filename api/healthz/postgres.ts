/**
 * W00-13 — `/healthz/postgres` for the Vercel-hosted API surface.
 *
 * Smoke's database check runs through the app, not through a psql from CI, and
 * compares the hashed `cluster` fingerprint across environments — two
 * environments must not share a cluster, and the fingerprint proves it without
 * either host publishing its hostname. `postgresStatus()` is the same probe
 * `src/server.ts` serves; the function is dependency wiring.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { postgresStatus } from "../../src/neon/postgres.ts";

export default async function handler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const status = await postgresStatus();
    const version = /PostgreSQL (\S+)/.exec(status.serverVersion)?.[1] ?? "unknown";
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        status: "ok",
        database: status.currentDatabase,
        server: version,
        cluster: status.clusterFingerprint,
        availableExtensions: status.availableExtensions,
      }),
    );
  } catch (error) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "degraded", detail: (error as Error).message }));
  }
}
