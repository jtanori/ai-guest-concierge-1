import { NextResponse, type NextRequest } from "next/server";
import { loadPropertyWire } from "@/lib/property";
import { publicBaseUrl } from "../../../../../src/guest/links.ts";
import { qrSvg } from "../../../../../src/guest/qr.ts";

/**
 * S07-01 AC-1 — `GET /c/:slug/qr.svg`.
 *
 * The property is resolved first, and a slug that resolves to nothing is a 404
 * rather than a QR. That matters: a QR is printed on a card and lives for
 * months, so publishing one for a typo or a deleted property ships a dead link
 * to a lobby. The API lookup is the same one the page uses.
 *
 * The encoded URL is absolute, and it comes from `GUEST_PUBLIC_URL` when set —
 * a server behind a proxy does not know its public name, and a QR encoding
 * `http://127.0.0.1:8787` scans to nothing.
 *
 * Why `image/svg+xml` and not a PNG, and why the cache header is long: the
 * payload never changes for a given property and language, it is a handful of
 * kilobytes of text, and a card does not get re-scanned when the deploy rolls.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const property = await loadPropertyWire(slug, "es");
  if (property === null) {
    return NextResponse.json({ error: "unknown_property" }, { status: 404 });
  }

  let svg: string;
  try {
    const baseUrl = publicBaseUrl(process.env["GUEST_PUBLIC_URL"], req.nextUrl.origin);
    svg = await qrSvg({ baseUrl, slug: property.slug });
  } catch {
    // A misconfigured base URL is our fault, not the guest's; say so as a 500
    // rather than serving a QR that points nowhere.
    return NextResponse.json({ error: "qr_unavailable" }, { status: 500 });
  }

  return new NextResponse(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
      // A QR is an image of a URL; it is inert, but it is also the only thing
      // that ever leaves this route, so nothing may sniff it into HTML.
      "x-content-type-options": "nosniff",
    },
  });
}
