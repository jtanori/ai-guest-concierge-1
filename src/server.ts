/**
 * W00 — minimal app server so `npm start` exists and every wired Neon
 * service has a health route. This is NOT the guest/staff product surface
 * (S01+ owns that): it is the smallest thing that can prove the wiring and
 * carry the future staging smoke checks.
 *
 * Run: npm start   (= node --env-file=.env.local --experimental-strip-types)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger, isLogLevel, type LogLevel } from "./logging/index.ts";
import { loadConfig } from "./config/env.ts";
import { postgresStatus, closePool } from "./neon/postgres.ts";
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

const cfg = loadConfig(process.env);
const log = createLogger((isLogLevel(cfg.logLevel) ? cfg.logLevel : "info") as LogLevel);
const startedAt = new Date().toISOString();

type Handler = () => Promise<Record<string, unknown> | string>;

const routes: Record<string, Handler> = {
  "/healthz": async () => ({
    status: "ok",
    env: cfg.env,
    startedAt,
  }),
  "/healthz/postgres": async () => {
    const status = await postgresStatus();
    const version = /PostgreSQL (\S+)/.exec(status.serverVersion)?.[1] ?? "unknown";
    return {
      status: "ok",
      database: status.currentDatabase,
      server: version,
      availableExtensions: status.availableExtensions,
    };
  },
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
  "/healthz/storage": async () => {
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
  },
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
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

server.listen(3000, "127.0.0.1", () => {
  log.info(
    {
      env: cfg.env,
      routes: Object.keys(routes),
      addr: "http://127.0.0.1:3000",
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
