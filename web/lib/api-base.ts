/**
 * Where the API lives, for the Next server only.
 *
 * Split out of `session.ts` (S07-01) because middleware needs this and must not
 * pull in `next/headers`: `cookies()` is not callable from middleware, and an
 * import that exists only for its side effects is an import that eventually
 * gets called by mistake.
 */
export function apiBase(): string {
  return process.env["REVIEW_API_URL"] ?? "http://127.0.0.1:8787";
}
