import { NextResponse, type NextRequest } from "next/server";
import { apiBase, readSession } from "@/lib/session";

/**
 * The only path from the browser to the review API.
 *
 * It exists so the bearer token can stay in an HttpOnly cookie: the client
 * calls `/api/review/...` on this origin, and this handler attaches the token
 * and the tenant headers. It adds no authorisation of its own — the API's
 * `requireRole` decides, which is why a front_desk user gets the same 403 here
 * as they would calling the API directly (tests/db/role-denial.db.test.ts).
 */
async function forward(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const session = await readSession();
  if (session === null) {
    return NextResponse.json({ error: "no_session" }, { status: 401 });
  }

  const { path } = await ctx.params;
  const target = `${apiBase()}/api/review/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;

  const headers: Record<string, string> = {
    authorization: `Bearer ${session.token}`,
    "x-org-id": session.orgId,
    "x-property-id": session.propertyId,
  };
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  if (body !== undefined && body !== "") headers["content-type"] = "application/json";

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method, headers, body, cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
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
