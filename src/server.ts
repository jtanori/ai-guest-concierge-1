/**
 * W00 — minimal app server so `npm start` exists and every wired Neon
 * service has a health route. This is NOT the guest/staff product surface
 * (S01+ owns that): it is the smallest thing that can prove the wiring and
 * carry the future staging smoke checks.
 *
 * Run: npm start   (= node --env-file=.env.local --experimental-strip-types)
 *
 * Deployed targets are tolerated, not required: on hosts that inject no
 * env file (e.g. Vercel preview runtimes) the server boots DEGRADED —
 * /healthz reports which services are unconfigured instead of crashing,
 * and every dependent route degrades to 503 with a useful detail line.
 * Bind address/port follow the hosting convention: PORT and HOST env
 * (Vercel-style) win, defaulting to 127.0.0.1:3000 for local dev.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type pg from "pg";
import { createLogger, isLogLevel, type LogLevel } from "./logging/index.ts";
import { loadConfig, type AppConfig } from "./config/env.ts";
import { postgresStatus, closePool, getPool } from "./neon/postgres.ts";
import { loadAuthConfig, verifyIdentityToken } from "./auth/session.ts";
import { handleReviewRequest, ownsReviewPath, type ReviewHttpDeps } from "./staff/http.ts";
import { authStatus } from "./neon/auth.ts";
import {
  getS3Client,
  putObject,
  getObject,
  deleteObject,
  NEON_BUCKET_ASSETS,
  NEON_SMOKE_PREFIX,
} from "./neon/storage.ts";
import { invokeHello } from "./neon/functions.ts";

/** Boot without a full config: hosting without env files must not crash. */
function loadConfigGracefully(source: NodeJS.ProcessEnv): [AppConfig | null, string | null] {
  try {
    return [loadConfig(source), null];
  } catch (error) {
    return [null, (error as Error).message];
  }
}

const [cfg, cfgError] = loadConfigGracefully(process.env);
const configuredLevel = cfg?.logLevel ?? "info";
const log = createLogger((isLogLevel(configuredLevel) ? configuredLevel : "info") as LogLevel);
const startedAt = new Date().toISOString();

type Handler = () => Promise<Record<string, unknown> | string>;

/** Route guard: a degraded-config host answers 503 with the reason. */
function withConfig(route: (cfg: AppConfig) => Promise<Record<string, unknown> | string>): Handler {
  return async () => {
    if (!cfg) throw new Error(`config unavailable in this hosted environment: ${cfgError}`);
    return route(cfg);
  };
}

const routes: Record<string, Handler> = {
  "/healthz": async () => ({
    status: "ok",
    env: cfg?.env ?? "unknown",
    config: cfgError ? `degraded: ${cfgError}` : "resolved",
    startedAt,
  }),
  "/healthz/postgres": withConfig(async () => {
    const status = await postgresStatus();
    const version = /PostgreSQL (\S+)/.exec(status.serverVersion)?.[1] ?? "unknown";
    return {
      status: "ok",
      database: status.currentDatabase,
      server: version,
      availableExtensions: status.availableExtensions,
    };
  }),
  "/healthz/auth": async () => {
    const status = await authStatus();
    return {
      status: status.baseReachable && status.jwksKeys > 0 ? "ok" : "degraded",
      baseHttp: status.baseUrlStatus,
      jwksKeys: status.jwksKeys,
    };
  },
  "/healthz/function": async () => {
    const res = await invokeHello();
    return { status: res.status === 200 ? "ok" : "degraded", http: res.status, body: res.body };
  },
  "/healthz/storage": withConfig(async () => {
    const client = getS3Client();
    const key = `${NEON_SMOKE_PREFIX}healthz-${Date.now()}.txt`;
    const body = `healthz ${new Date().toISOString()}`;
    await putObject(client, NEON_BUCKET_ASSETS, key, body);
    const roundTrip = await getObject(client, NEON_BUCKET_ASSETS, key);
    await deleteObject(client, NEON_BUCKET_ASSETS, key);
    return {
      status: roundTrip === body ? "ok" : "degraded",
      bucket: NEON_BUCKET_ASSETS,
      putGetIdentical: roundTrip === body,
    };
  }),
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

/**
 * S04-01 — the first staff surface. Auth config is resolved per request so a
 * host without Neon Auth answers 503 with a reason instead of refusing to boot
 * (the same degraded-host contract the health routes follow).
 */
function reviewDeps(client: ReviewHttpDeps["client"]): ReviewHttpDeps {
  const auth = loadAuthConfig(process.env);
  return {
    client,
    verifyToken: (token) =>
      verifyIdentityToken(token, { url: auth.url }, { issuer: auth.issuer, audience: auth.audience }),
  };
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;

  if (ownsReviewPath(path)) {
    // One checked-out client per request: withStaffSession runs BEGIN/COMMIT,
    // so it must never borrow a different connection per statement.
    void (async () => {
      let deps: ReviewHttpDeps;
      let client: pg.PoolClient;
      try {
        client = await getPool().connect();
      } catch (error) {
        send(res, 503, { status: "error", path, detail: (error as Error).message });
        return;
      }
      try {
        deps = reviewDeps(client);
      } catch (error) {
        client.release();
        send(res, 503, { status: "error", path, detail: (error as Error).message });
        return;
      }
      try {
        await handleReviewRequest(req, res, deps);
      } finally {
        client.release();
      }
    })();
    return;
  }

  const handler = routes[path];
  if (!handler) {
    send(res, 404, { status: "not_found", path });
    return;
  }
  handler()
    .then((body) => send(res, 200, body))
    .catch((error: unknown) => {
      log.error({ err: (error as Error).message, path }, "health route failed");
      send(res, 503, { status: "error", path, detail: (error as Error).message });
    });
});

const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "127.0.0.1";

server.listen(port, host, () => {
  log.info(
    {
      env: cfg?.env ?? "unknown",
      config: cfgError ? "degraded" : "resolved",
      routes: Object.keys(routes),
      addr: `http://${host}:${port}`,
    },
    "health server listening",
  );
});

async function shutdown(): Promise<void> {
  log.info("shutting down");
  server.close();
  await closePool();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
