import { NextResponse, type NextRequest } from "next/server";
import { apiBase } from "@/lib/api-base";
import { publicBaseUrl } from "../../../../../src/guest/links.ts";

/**
 * S07-01 AC-1 — `GET /c/:slug/qr.svg`.
 *
 * The encoding itself happens in the API (`/api/chat/qr.svg`), not here. Two
 * reasons, in order of how much they hurt:
 *
 *  1. **This project installs only its own dependencies.** CI's `web-build` job
 *     runs `npm ci` inside `web/`, so a file under `web/` that imports
 *     `src/guest/qr.ts` — which needs `qrcode` — resolves the package from the
 *     root `node_modules`, which is not there. It built locally (root deps
 *     installed) and failed in CI. A cross-project source import is fine for
 *     pure TypeScript and is a trap for anything with a runtime dependency.
 *  2. The API already owns the slug lookup and the public base URL. One place
 *     encodes, one place can 404.
 *
 * So this is a proxy, deliberately the same shape as `/api/chat/*`: the browser
 * never talks to the API, and the guest's URL never carries a tenant id.
 *
 * A slug that resolves to nothing is a 404 here too — a QR is printed on a card
 * and lives for months, so publishing one for a typo ships a dead link to a
 * lobby.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;

  let base: string;
  try {
    base = publicBaseUrl(process.env["GUEST_PUBLIC_URL"], req.nextUrl.origin);
  } catch {
    // A misconfigured base URL is ours to fix; better a 500 than a QR that
    // points somewhere nobody chose.
    return NextResponse.json({ error: "qr_unavailable" }, { status: 500 });
  }

  let response: Response;
  try {
    response = await fetch(
      `${apiBase()}/api/chat/qr.svg?property=${encodeURIComponent(slug)}&base=${encodeURIComponent(base)}`,
      { cache: "no-store" },
    );
  } catch {
    return NextResponse.json({ error: "qr_unavailable" }, { status: 503 });
  }

  if (!response.ok) {
    return NextResponse.json({ error: "unknown_property" }, { status: 404 });
  }

  return new NextResponse(await response.text(), {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // The payload never changes for a property; a card does not get
      // re-scanned when the deploy rolls.
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
