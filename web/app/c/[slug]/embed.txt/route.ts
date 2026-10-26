import { NextResponse, type NextRequest } from "next/server";
import { loadPropertyWire } from "@/lib/property";
import { embedSnippet, publicBaseUrl } from "../../../../../src/guest/links.ts";
import { t } from "../../../../../src/i18n/catalog.ts";

/**
 * S07-01 AC-2 — `GET /c/:slug/embed.txt`: the copy-paste snippet, as text.
 *
 * The snippet has to reach the person who edits the hotel's website, and that
 * person is not going to read this repository. A plain-text response is the
 * smallest thing that can be pasted into an email, a ticket or a `<pre>` block
 * without stripping markup — and it is the same `embedSnippet()` the tests
 * exercise, so what is handed over is what was verified.
 *
 * The QR is the same story: `/c/:slug/qr.svg` is a file the operator downloads,
 * this route is the text. Neither carries a tenant id or a token.
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

  let snippet: string;
  try {
    const baseUrl = publicBaseUrl(process.env["GUEST_PUBLIC_URL"], req.nextUrl.origin);
    snippet = embedSnippet({
      baseUrl,
      slug: property.slug,
      lang,
      title: t("guest.chat.heading", lang),
    });
  } catch {
    return NextResponse.json({ error: "embed_unavailable" }, { status: 500 });
  }

  return new NextResponse(`${snippet}\n`, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
