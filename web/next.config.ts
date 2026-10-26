import type { NextConfig } from "next";

/**
 * S04-01. The screen is a client of the JSON surface that `src/server.ts`
 * already serves (`/api/review/*`), never a second copy of the business
 * logic: approve, reject and resolve all go through the same handlers the
 * denial suite exercises, so a role that cannot write cannot write here either.
 *
 * REVIEW_API_URL points at that server. Nothing in the browser ever calls it
 * directly — every request goes through `app/api/review/[...path]/route.ts`,
 * which adds the bearer token from an HttpOnly cookie. That keeps the token
 * out of the browser's storage and out of the rendered HTML.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
