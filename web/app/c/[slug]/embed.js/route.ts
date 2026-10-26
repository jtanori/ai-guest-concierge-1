import { NextResponse, type NextRequest } from "next/server";
import { loadPropertyWire } from "@/lib/property";
import { embedScript, publicBaseUrl } from "../../../../../src/guest/links.ts";
import { t } from "../../../../../src/i18n/catalog.ts";

/**
 * S07-01 AC-2 — `GET /c/:slug/embed.js`, the script the snippet pulls in.
 *
 * Two things this route is careful about:
 *
 *  - **A slug that does not exist gets a 404, not JavaScript.** The hotel pastes
 *    the snippet once and never looks again; a 404 is visible in their console
 *    while an empty script is not.
 *  - **The iframe's accessible name comes from the catalogue.** The script runs
 *    in the hotel's page, but the copy is still ours and still bilingual
 *    (`guest.chat.heading`), which is the same rule as every other guest string.
 *
 * `cross-origin-resource-policy: cross-origin` is deliberate: this script is
 * meant to be loaded from another origin. Everything else here is served
 * same-origin, so the exception is stated rather than inherited.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const requested = req.nextUrl.searchParams.get("lang");
  const lang = requested === "en" ? "en" : "es";
  const property = await loadPropertyWire(slug, lang);
  if (property === null) {
    return NextResponse.json({ error: "unknown_property" }, { status: 404 });
  }

  let script: string;
  try {
    const baseUrl = publicBaseUrl(process.env["GUEST_PUBLIC_URL"], req.nextUrl.origin);
    script = embedScript({ baseUrl, slug: property.slug, lang, title: t("guest.chat.heading", lang) });
  } catch {
    return NextResponse.json({ error: "embed_unavailable" }, { status: 500 });
  }

  return new NextResponse(script, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}
