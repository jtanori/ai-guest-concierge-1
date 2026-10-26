/**
 * S04-01 — Vercel entry point for the staff review API.
 *
 * The routing, auth and role checks live in `src/staff/http.ts` (shared with
 * `src/server.ts`, so local and deployed behaviour cannot drift). This file only
 * builds the real dependencies and reports a degraded host as 503.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getPool } from "../../src/neon/postgres.ts";
import { loadAuthConfig, verifyIdentityToken } from "../../src/auth/session.ts";
import { handleReviewRequest, type ReviewHttpDeps } from "../../src/staff/http.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let auth;
  let client;
  try {
    auth = loadAuthConfig(process.env);
    // One checked-out client: withStaffSession runs BEGIN/COMMIT on it.
    client = await getPool().connect();
  } catch (error) {
    client?.release();
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "error", detail: (error as Error).message }));
    return;
  }
  const deps: ReviewHttpDeps = {
    client,
    verifyToken: (token) =>
      verifyIdentityToken(token, { url: auth.url }, { issuer: auth.issuer, audience: auth.audience }),
  };
  try {
    await handleReviewRequest(req, res, deps);
  } finally {
    client.release();
  }
}
