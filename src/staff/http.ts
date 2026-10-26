/**
 * S04-01 / S02-06 / S08-01 — the staff HTTP surfaces (`/api/review/*` and
 * `/api/inbox`), and the first production place where a role decides whether a
 * request runs at all.
 *
 * Design notes:
 *
 *  - Authentication happens BEFORE the transaction: `verifyToken` runs first,
 *    so a bad or expired bearer token costs no database work.
 *  - Authorisation happens before any query: `withStaffSession` resolves the
 *    caller's role from `memberships` (never from the token) and the service
 *    calls `session.requireRole("knowledge", ...)` as its first statement. A
 *    denied caller gets 403 and leaves zero writes behind.
 *  - The tenant comes from headers, not the body: `x-org-id` + `x-property-id`.
 *    Both are checked against the caller's membership inside `withStaffSession`
 *    (`NoMembershipError`), so a well-formed foreign pair is refused and the
 *    response cannot confirm whether that property exists.
 *  - `verifyToken` and `contextFrom` are injected so the denial suite can run
 *    without a JWKS server (tests/staff/http.test.ts) while `src/server.ts`
 *    passes the real verifier.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import { RoleNotOnSurfaceError } from "../auth/guard.ts";
import {
  NoMembershipError,
  UnknownStaffUserError,
  withStaffSession,
  type StaffSession,
  type TenantContext,
} from "../auth/context.ts";
import { AuthVerifyError, type StaffIdentity } from "../auth/session.ts";
import { ArticleValidationError, ArticleVersionNotFoundError } from "../knowledge/articles.ts";
import {
  FactContradictionError,
  FactNotFoundError,
  FactValidationError,
  listContradictions,
} from "../knowledge/facts.ts";
import { InboxInputError, listInbox } from "../inbox/queries.ts";
import { ConversationNotFoundError, getConversationDetail } from "../inbox/detail.ts";
import {
  ContradictionGroupNotFoundError,
  ContradictionWinnerError,
  ReviewInputError,
  ReviewNotFoundError,
  approveVersion,
  listReviewQueue,
  rejectVersion,
  resolveContradiction,
} from "../knowledge/review.ts";

export interface ReviewHttpDeps {
  client: pg.Client | pg.PoolClient;
  /** Bearer token → verified identity. Real one is `verifyIdentityToken`. */
  verifyToken: (token: string) => Promise<StaffIdentity>;
  /** Tenant addressed by the request. Defaults to the `x-org-id`/`x-property-id` headers. */
  contextFrom?: (req: IncomingMessage) => TenantContext;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;

const REVIEW_PREFIX = "/api/review";
const INBOX_PREFIX = "/api/inbox";

/** 401/403/404/409/400 mapping — one place, so no route invents its own code. */
interface Failure {
  status: number;
  error: string;
  extra?: Record<string, unknown>;
}

export function classifyError(error: unknown): Failure {
  if (error instanceof AuthVerifyError || error instanceof UnknownStaffUserError) {
    return { status: 401, error: "unauthorized" };
  }
  if (error instanceof NoMembershipError) {
    return { status: 403, error: "no_membership" };
  }
  if (error instanceof RoleNotOnSurfaceError) {
    return { status: 403, error: "role_not_on_surface", extra: { detail: error.message } };
  }
  if (error instanceof ConversationNotFoundError) {
    // S08-02: one 404 for "no such conversation" and "not yours" — the same
    // reason the guest surface does not distinguish them.
    return { status: 404, error: "not_found", extra: { detail: error.message } };
  }
  if (
    error instanceof ReviewNotFoundError ||
    error instanceof ArticleVersionNotFoundError ||
    error instanceof FactNotFoundError ||
    error instanceof ContradictionGroupNotFoundError
  ) {
    return { status: 404, error: "not_found", extra: { detail: (error as Error).message } };
  }
  if (error instanceof FactContradictionError) {
    return { status: 409, error: "contradiction", extra: { detail: error.message } };
  }
  if (error instanceof InboxInputError) {
    return { status: 400, error: "invalid_request", extra: { detail: error.message } };
  }
  if (
    error instanceof ReviewInputError ||
    error instanceof ContradictionWinnerError ||
    error instanceof FactValidationError ||
    error instanceof ArticleValidationError
  ) {
    return { status: 400, error: "invalid_request", extra: { detail: (error as Error).message } };
  }
  return { status: 500, error: "internal_error" };
}

export function tenantFromHeaders(req: IncomingMessage): TenantContext {
  const raw = (name: string): string => {
    const value = req.headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === "string" ? single.trim() : "";
  };
  const orgId = raw("x-org-id");
  const propertyId = raw("x-property-id");
  if (!UUID_RE.test(orgId) || !UUID_RE.test(propertyId)) {
    throw new ReviewInputError("x-org-id and x-property-id headers are required UUIDs");
  }
  return { orgId, propertyId };
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    throw new AuthVerifyError("missing bearer token");
  }
  const token = value.slice("Bearer ".length).trim();
  if (token.length === 0) throw new AuthVerifyError("missing bearer token");
  return token;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ReviewInputError("request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReviewInputError("request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ReviewInputError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

type Route = {
  method: "GET" | "POST";
  pattern: RegExp;
  run: (
    match: RegExpExecArray,
    deps: ReviewHttpDeps,
    session: StaffSession,
    scoped: pg.Client | pg.PoolClient,
    context: TenantContext,
    req: IncomingMessage,
  ) => Promise<unknown>;
};

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/review\/queue$/,
    run: (_m, _d, session, scoped, context) => listReviewQueue(scoped, context, session),
  },
  {
    // Read-only half of the contradiction queue: the screen must show both
    // sides before anyone can pick a winner.
    method: "GET",
    pattern: /^\/api\/review\/contradictions$/,
    run: (_m, _d, _session, scoped, context) => listContradictions(scoped, context),
  },
  {
    method: "POST",
    pattern: /^\/api\/review\/versions\/([0-9a-f-]{36})\/approve$/i,
    run: (m, _d, session, scoped, context) =>
      approveVersion(scoped, context, session, m[1]!),
  },
  {
    method: "POST",
    pattern: /^\/api\/review\/versions\/([0-9a-f-]{36})\/reject$/i,
    run: (m, _d, session, scoped, context) =>
      rejectVersion(scoped, context, session, m[1]!),
  },
  {
    method: "POST",
    pattern: /^\/api\/review\/contradictions\/resolve$/,
    run: async (_m, _d, session, scoped, context, req) => {
      const body = await readJson(req);
      return resolveContradiction(scoped, context, session, {
        topicKey: String(body["topicKey"] ?? ""),
        factKey: String(body["factKey"] ?? ""),
        language: String(body["language"] ?? ""),
        effectiveFrom:
          body["effectiveFrom"] === undefined || body["effectiveFrom"] === null
            ? null
            : String(body["effectiveFrom"]),
        winnerFactId: String(body["winnerFactId"] ?? ""),
      });
    },
  },
];

/**
 * S08-01 — the inbox. One route, three filters, keyset pages.
 *
 * The filter is a query parameter rather than a path segment so that a page
 * link is a URL the browser can reopen from history: `/api/inbox?filter=mine`
 * survives a reload, and the screen can be a plain server-rendered page with
 * `<Link>`s instead of client state (DEC-1).
 */
const INBOX_ROUTES: Route[] = [
  {
    // S08-02 — the conversation, its transcript, and the sources behind each
    // answer. Read-only: staff do not act on a conversation in this item.
    method: "GET",
    pattern: /^\/api\/inbox\/conversations\/([0-9a-f-]{36})$/i,
    run: (m, _d, session, scoped, context) =>
      getConversationDetail(scoped, context, session, m[1]!),
  },
  {
    method: "GET",
    pattern: /^\/api\/inbox$/,
    run: (_m, _d, session, scoped, context, req) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      return listInbox(scoped, context, session, {
        filter: url.searchParams.get("filter"),
        limit: url.searchParams.get("limit"),
        cursor: url.searchParams.get("cursor"),
      });
    },
  },
];

/** True when this handler owns the path (so the health table never sees it). */
export function ownsReviewPath(path: string): boolean {
  return path === REVIEW_PREFIX || path.startsWith(`${REVIEW_PREFIX}/`);
}

/** True for `/api/inbox` (S08-01). */
export function ownsInboxPath(path: string): boolean {
  return path === INBOX_PREFIX || path.startsWith(`${INBOX_PREFIX}/`);
}

/**
 * Handles one `/api/review/*` request. Always writes a response; never throws
 * for a client-side problem (the status code carries it).
 */
export function handleReviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReviewHttpDeps,
): Promise<void> {
  return handleStaffRequest(req, res, deps, ROUTES);
}

/** S08-01 — `/api/inbox`, through the same identity → tenant → role pipeline. */
export function handleInboxRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReviewHttpDeps,
): Promise<void> {
  return handleStaffRequest(req, res, deps, INBOX_ROUTES);
}

/**
 * The pipeline both surfaces share, in this order and for these reasons:
 * verify the token (no database work for an unverified caller), resolve the
 * tenant from the headers (membership-checked inside the transaction), then run
 * role-checked work. Copying it for the second surface would be how the two
 * drift apart — and the drift would be a missing `requireRole`.
 */
async function handleStaffRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReviewHttpDeps,
  table: Route[],
): Promise<void> {
  const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const contextFrom = deps.contextFrom ?? tenantFromHeaders;

  try {
    const route = table.find((candidate) => candidate.pattern.test(path));
    if (route === undefined) {
      send(res, 404, { error: "not_found", path });
      return;
    }
    if (route.method !== method) {
      res.setHeader("allow", route.method);
      send(res, 405, { error: "method_not_allowed", method });
      return;
    }

    // 1. identity first: no DB work for an unverified caller.
    const identity = await deps.verifyToken(bearerToken(req));
    // 2. tenant from the request, membership-checked inside the transaction.
    const context = contextFrom(req);
    // 3. role-checked work (the service's first statement is requireRole).
    const body = await withStaffSession(deps.client, context, identity, (session, scoped) => {
      const match = route.pattern.exec(path)!;
      return route.run(match, deps, session, scoped, context, req);
    });
    send(res, 200, body);
  } catch (error) {
    const failure = classifyError(error);
    send(res, failure.status, { error: failure.error, ...(failure.extra ?? {}) });
  }
}
