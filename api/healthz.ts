/**
 * W00-13 — `/healthz` for the Vercel-hosted API surface.
 *
 * The contract smoke script probes `${API_URL}/healthz` and requires an honest
 * `env` (staging must report staging — the check that catches a copied secret
 * pointing staging at the production database) and `boot: strict`. `src/server.ts`
 * serves this route for the long-running host; this file serves the same route
 * from the same loaders so the two cannot report different things. The routing,
 * the boot contract and the config matrix all live in `src/` — this is
 * dependency wiring, nothing more.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, resolveBootMode } from "../src/config/env.ts";

const startedAt = new Date().toISOString();

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  try {
    // Strict by construction: resolveBootMode throws on prod+ALLOW_DEGRADED_BOOT,
    // and loadConfig throws on a missing required name (DATABASE_URL, APP_ENV=…).
    // A broken config answers 503 with the reason instead of reporting "ok".
    const cfg = loadConfig(process.env);
    const boot = resolveBootMode(process.env);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        status: "ok",
        env: cfg.env,
        config: "resolved",
        boot: boot.mode,
        startedAt,
      }),
    );
  } catch (error) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "degraded", detail: (error as Error).message }));
  }
}
