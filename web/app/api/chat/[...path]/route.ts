import { NextResponse, type NextRequest } from "next/server";
import { apiBase } from "@/lib/session";

/**
 * S06-01 — the browser's only path to the guest API.
 *
 * It forwards two things and adds nothing:
 *
 *  - the **query string**, which is where the tenant lives (`?property=<slug>`),
 *    so the tenant decision stays on the server side of this boundary;
 *  - the **cookie header** in both directions, because the guest identity is an
 *    HttpOnly signed cookie and the browser must be able to carry it without
 *    being able to read or edit it.
 *
 * No authorisation lives here either, deliberately: `src/guest/http.ts` decides,
 * and a proxy that also decided would be a second, divergent rulebook.
 */
async function forward(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const target = `${apiBase()}/api/chat/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;

  const headers: Record<string, string> = { accept: "application/json" };
  const cookie = req.headers.get("cookie");
  if (cookie !== null && cookie !== "") headers["cookie"] = cookie;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  if (body !== undefined && body !== "") headers["content-type"] = "application/json";

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method, headers, body, cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });
  }

  const text = await upstream.text();
  const response = new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  // The signed identity cookie has to survive the hop, or every message would
  // start a new conversation.
  const setCookie = upstream.headers.get("set-cookie");
  if (setCookie !== null) response.headers.set("set-cookie", setCookie);
  const allow = upstream.headers.get("allow");
  if (allow !== null) response.headers.set("allow", allow);
  return response;
}

export function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  return forward(req, ctx);
}

export function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  return forward(req, ctx);
}
