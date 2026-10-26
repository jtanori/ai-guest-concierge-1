import { NextResponse, type NextRequest } from "next/server";
import { frameAncestorsDirective } from "../src/guest/links.ts";
import { loadPropertyWire } from "./lib/property";

/**
 * S07-01 — "who may frame this chat", as a response header.
 *
 * A page's framing policy has to be sent by the server that serves the page, and
 * in the App Router that means middleware: a page component can read headers but
 * cannot set them. The policy is per property (settings `embed.allowed_origins`,
 * 0020), so the allowlist comes from the API — the only thing that can turn a
 * slug into a property.
 *
 * ## The cache is the point, and the risk
 *
 * Middleware runs on every page view, and a chat page is the most-visited route
 * in the product. A per-request API call would put our own API in the critical
 * path of every guest page. So the directive is cached in memory for 60 seconds
 * per slug — per replica, so a rotation of the allowlist takes up to a minute to
 * reach every instance, which is the right trade for a header that governs
 * framing rather than access.
 *
 * A failure to resolve the property (API down, unknown slug) caches `'self'`,
 * never a wildcard: the fail-closed default is "only a direct visit", and the
 * page itself will 404 for an unknown slug anyway.
 *
 * ## Scope
 *
 * `matcher` is exactly `/c/:slug`, so the QR and the embed script — which are
 * images and JavaScript, not documents — are not touched, and neither is any
 * staff route. `'self'` is always included: an empty allowlist must not stop a
 * guest who typed the URL themselves.
 */
export const config = { matcher: ["/c/:slug"] };

const CACHE_TTL_MS = 60_000;

interface Entry {
  directive: string;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

async function directiveFor(slug: string): Promise<string> {
  const now = Date.now();
  const cached = cache.get(slug);
  if (cached !== undefined && cached.expiresAt > now) return cached.directive;

  const property = await loadPropertyWire(slug, "es");
  const directive = frameAncestorsDirective(property?.frameAncestors ?? []);
  cache.set(slug, { directive, expiresAt: now + CACHE_TTL_MS });
  return directive;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  // `/c/<slug>` — the matcher guarantees the shape.
  const slug = req.nextUrl.pathname.split("/")[2] ?? "";
  const response = NextResponse.next();
  const directive = await directiveFor(slug);
  response.headers.set("content-security-policy", `frame-ancestors ${directive}`);
  // The transcript is per-guest; a framing host must not get a cacheable page.
  response.headers.set("cache-control", "no-store");
  return response;
}
