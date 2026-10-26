/**
 * S07-01 — the links OUT of the chat: a QR code for the front desk, and a
 * snippet for the hotel's own website.
 *
 * Everything here is pure (no database, no request object) so the awkward parts
 * — URL building, origin matching, escaping — are testable without a server or a
 * phone. The route handlers in `web/` are thin wrappers over these functions.
 *
 * ## The QR encodes the guest URL, and nothing else
 *
 * No tenant ids, no tracking parameters, no signed payloads. A QR code on a
 * printed card in a lobby is public forever: it can be photographed, re-printed
 * and reposted. The only thing it may contain is the same URL a guest could type
 * by hand, so a leaked code leaks nothing.
 *
 * ## Matching an embedder is exact, and empty means nobody
 *
 * `isFrameAllowed` compares a **normalised origin** against the property's
 * allowlist. There is no prefix matching and no wildcard: `https://hotel.example`
 * must not allow `https://hotel.example.evil.test`, which is exactly what a
 * naive `startsWith` would do. An empty allowlist refuses every embedder
 * (including `'self'`-only framing, which the CSP keeps separate).
 */
import { normaliseOrigin } from "../settings/schema.ts";

/**
 * A property slug, as the database stores it: lower-case ASCII, digits and
 * inner hyphens, 1–63 characters.
 *
 * Declared here rather than imported from `session.ts` so this module stays
 * pure — it is bundled into the Next middleware (S07-01), and dragging the
 * session module's database imports into an edge bundle for one regex is how a
 * middleware starts failing in production only. The two definitions are pinned
 * to each other by a test in `tests/guest/links.test.ts`.
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Thrown for a slug or base URL that could not have come from a real link. */
export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

/**
 * The guest-facing origin, for absolute links.
 *
 * Configured (`GUEST_PUBLIC_URL`) wins, because a server behind a proxy often
 * cannot see its own public name. The request origin is the fallback, and it is
 * the honest one for a preview host: a QR that encodes `http://127.0.0.1:8787`
 * is a QR that scans to nothing, which is better than one that scans to the wrong
 * hotel.
 */
export function publicBaseUrl(configured: string | undefined, requestOrigin: string): string {
  const candidate = (configured ?? "").trim();
  if (candidate !== "") {
    const origin = normaliseOrigin(candidate);
    if (origin === null) {
      throw new LinkError(
        `GUEST_PUBLIC_URL must be an origin like https://chat.example.com, got "${candidate}"`,
      );
    }
    return origin;
  }
  const origin = normaliseOrigin(requestOrigin);
  if (origin === null) throw new LinkError(`request origin is not an origin: "${requestOrigin}"`);
  return origin;
}

/**
 * The public chat URL for one property. This is what the QR contains and what
 * the snippet points an iframe at, so the two cannot disagree.
 */
export function chatUrl(baseUrl: string, slug: string, lang?: string | null): string {
  // A slug that fails this check is a 404 everywhere else in the system; making
  // a QR of it would publish the 404.
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new LinkError(`invalid slug "${slug}"`);
  const base = normaliseOrigin(baseUrl);
  if (base === null) throw new LinkError(`invalid base URL "${baseUrl}"`);
  const language = lang === "es" || lang === "en" ? lang : null;
  return `${base}/c/${slug}${language === null ? "" : `?lang=${language}`}`;
}

/** The same URL, as an absolute path a same-origin page can use. */
export function chatPath(slug: string, lang?: string | null): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new LinkError(`invalid slug "${slug}"`);
  const language = lang === "es" || lang === "en" ? lang : null;
  return `/c/${slug}${language === null ? "" : `?lang=${language}`}`;
}

/**
 * The URL of the embed script itself.
 *
 * A separate builder because the query string has to land AFTER the file name:
 * `/c/demo?lang=es/embed.js` is a 404, and it is exactly what the first version
 * of this file produced — caught by curling the running server rather than by a
 * unit test, which is why this now has one.
 */
export function embedScriptUrl(baseUrl: string, slug: string, lang?: string | null): string {
  const base = normaliseOrigin(baseUrl);
  if (base === null) throw new LinkError(`invalid base URL "${baseUrl}"`);
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new LinkError(`invalid slug "${slug}"`);
  const language = lang === "es" || lang === "en" ? lang : null;
  return `${base}/c/${slug}/embed.js${language === null ? "" : `?lang=${language}`}`;
}

/**
 * The `frame-ancestors` value for a property: `'self'` (a guest visiting
 * directly) plus every configured origin. An empty allowlist is still `'self'`,
 * which is what stops "nobody may embed" from becoming "nobody may visit".
 */
export function frameAncestorsDirective(allowedOrigins: readonly string[]): string {
  const origins = allowedOrigins
    .map((origin) => normaliseOrigin(origin))
    .filter((origin): origin is string => origin !== null);
  return ["'self'", ...new Set(origins)].join(" ");
}

/** Exact-origin membership. Never a prefix test — see the header. */
export function isFrameAllowed(
  requestOrigin: string | null | undefined,
  allowedOrigins: readonly string[],
): boolean {
  const origin = normaliseOrigin(requestOrigin ?? "");
  if (origin === null) return false;
  return allowedOrigins.some((allowed) => normaliseOrigin(allowed) === origin);
}

/** JSON-encodes a value for embedding inside a `<script>` body or attribute. */
function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function htmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface EmbedOptions {
  /** Public origin of this deployment, e.g. `https://chat.example.com`. */
  baseUrl: string;
  slug: string;
  lang?: string | null;
  /** The iframe's accessible name; catalogue copy, never hardcoded. */
  title: string;
}

/**
 * The copy-paste snippet for the hotel's site.
 *
 * One `<script>` tag and one container. The container is explicit rather than
 * implied: a hotel that pastes this into a template wants the chat in a
 * particular place, and an embed that inserts itself at the bottom of `<body>`
 * is an embed that fights the page it is in.
 */
export function embedSnippet(options: EmbedOptions): string {
  const src = embedScriptUrl(options.baseUrl, options.slug, options.lang);
  return [
    `<div id="concierge-chat" data-concierge-property="${htmlAttribute(options.slug)}"></div>`,
    `<script src="${htmlAttribute(src)}" async></script>`,
  ].join("\n");
}

/**
 * The body of `GET /c/:slug/embed.js`.
 *
 * Written as a string because it runs in the hotel's browser, not ours: no
 * imports, no build step, no assumption about their bundler. It mounts into
 * `#concierge-chat` when the container exists and appends itself otherwise, so
 * the snippet works both as the documented copy-paste and as a bare script tag.
 *
 * `sandbox` is deliberately NOT set: the chat needs cookies and forms to work,
 * and a sandbox without `allow-same-origin allow-forms allow-scripts` would
 * silently break the thing it is embedding. `frame-ancestors` on our side is the
 * control that matters — the page decides who may frame it, not the framer.
 */
export function embedScript(options: EmbedOptions): string {
  const src = chatUrl(options.baseUrl, options.slug, options.lang);
  return `/* S07-01 — guest chat embed for property "${options.slug}". */
(function () {
  "use strict";
  var SRC = ${jsString(src)};
  var TITLE = ${jsString(options.title)};
  var ID = "concierge-chat";

  function mount() {
    if (document.getElementById(ID + "-frame")) return;
    var frame = document.createElement("iframe");
    frame.id = ID + "-frame";
    frame.src = SRC;
    frame.title = TITLE;
    frame.loading = "lazy";
    frame.setAttribute("allow", "clipboard-write");
    frame.style.cssText = "width:100%;height:620px;border:0;border-radius:12px;display:block;";
    var host = document.getElementById(ID);
    if (host) {
      host.appendChild(frame);
      return;
    }
    // No container: put the chat where the script tag was, which is where the
    // person who pasted it expects it.
    var script = document.currentScript;
    if (script && script.parentNode) script.parentNode.insertBefore(frame, script.nextSibling);
    else document.body.appendChild(frame);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
`;
}
