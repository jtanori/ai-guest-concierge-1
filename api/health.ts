/**
 * W00-12 — preview-probe surface for the Vercel preview deploy.
 *
 * This is CI plumbing, NOT product: the W00-12 AC is "a PR produces a
 * preview URL and a green check" — this endpoint is what the preview URL
 * serves until S01 starts shipping the real API surface, at which point
 * this file either grows the health contract or the product routes replace
 * it. Keep it dependency-free so the Vercel builder has nothing to bundle.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      status: "ok",
      service: "ai-guest-concierge",
      surface: "ci-preview-probe",
    }),
  );
}
