/**
 * S04-01 — the HTTP seam's pure half: status mapping and tenant extraction.
 *
 * No database, no JWKS: the point is that a client-side mistake maps to one
 * documented status code, and that a missing/!UUID tenant is a 400 rather than
 * a query against whatever happens to be in the headers.
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { AuthVerifyError } from "../../src/auth/session.ts";
import { NoMembershipError, UnknownStaffUserError } from "../../src/auth/context.ts";
import { RoleNotOnSurfaceError } from "../../src/auth/guard.ts";
import { ArticleValidationError, ArticleVersionNotFoundError } from "../../src/knowledge/articles.ts";
import { FactContradictionError, FactNotFoundError, FactValidationError } from "../../src/knowledge/facts.ts";
import {
  ContradictionGroupNotFoundError,
  ContradictionWinnerError,
  ReviewInputError,
  ReviewNotFoundError,
} from "../../src/knowledge/review.ts";
import {
  RequestLifecycleError,
  RequestNotFoundError,
} from "../../src/requests/lifecycle.ts";
import {
  DashboardPropertyNotFoundError,
  DashboardRangeError,
} from "../../src/analytics/dashboard.ts";
import {
  classifyError,
  ownsAnalyticsPath,
  ownsInboxPath,
  ownsReviewPath,
  tenantFromHeaders,
} from "../../src/staff/http.ts";

const ORG = "11111111-1111-5111-a111-111111111111";
const PROP = "22222222-2222-5222-a222-222222222222";

function reqWith(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("review surface: status mapping (S04-01)", () => {
  it("maps an unverified or unknown caller to 401", () => {
    expect(classifyError(new AuthVerifyError("bad token")).status).toBe(401);
    expect(classifyError(new UnknownStaffUserError("no identity")).status).toBe(401);
  });

  it("maps a role denial to 403 and names it", () => {
    const failure = classifyError(new RoleNotOnSurfaceError("observer", "knowledge", "write"));
    expect(failure.status).toBe(403);
    expect(failure.error).toBe("role_not_on_surface");
    expect(String(failure.extra?.["detail"])).toMatch(/observer/);
  });

  it("maps a missing membership to 403, distinct from a role denial", () => {
    const failure = classifyError(new NoMembershipError("no membership in property x"));
    expect(failure.status).toBe(403);
    expect(failure.error).toBe("no_membership");
  });

  it("maps not-found to 404 and a contradicting verify to 409", () => {
    expect(classifyError(new ReviewNotFoundError("id")).status).toBe(404);
    expect(classifyError(new ArticleVersionNotFoundError("id")).status).toBe(404);
    expect(classifyError(new FactNotFoundError("id")).status).toBe(404);
    expect(classifyError(new ContradictionGroupNotFoundError("k")).status).toBe(404);
    expect(classifyError(new FactContradictionError("a", "b", "21:00")).status).toBe(409);
  });

  it("maps bad input to 400", () => {
    expect(classifyError(new ReviewInputError("bad")).status).toBe(400);
    expect(classifyError(new ContradictionWinnerError("w", "k")).status).toBe(400);
    expect(classifyError(new FactValidationError("value", "empty")).status).toBe(400);
    expect(classifyError(new ArticleValidationError("title", "empty")).status).toBe(400);
  });

  it("never leaks an unexpected error's message", () => {
    const failure = classifyError(new Error("connection string postgres://user:pw@host"));
    expect(failure).toEqual({ status: 500, error: "internal_error" });
  });
});

describe("request lifecycle: status mapping (S09-01)", () => {
  it("maps a refused edge to 409, distinct from a missing request", () => {
    // 409 and not 400: the caller's request was well formed, the *state* refused
    // it. A 400 would tell the UI to stop sending a valid edge.
    const conflict = classifyError(new RequestLifecycleError("illegal request transition new → resolved"));
    expect(conflict.status).toBe(409);
    expect(conflict.error).toBe("request_transition_conflict");
    expect(classifyError(new RequestNotFoundError("id")).status).toBe(404);
  });

  it("answers 404 for another tenant's request, never 403", () => {
    // The service scopes the lookup by (org_id, property_id), so a valid id from
    // somebody else's property is indistinguishable from one that never existed —
    // the same reason the guest surface and S08-02's detail do not distinguish
    // them. A 403 would confirm the id is real.
    expect(classifyError(new RequestNotFoundError("foreign")).error).toBe("not_found");
  });

  it("claims /api/inbox, which now also carries the request-scoped edges", () => {
    expect(ownsInboxPath("/api/inbox/requests/abc/acknowledge")).toBe(true);
    expect(ownsInboxPath("/api/inbox")).toBe(true);
    expect(ownsInboxPath("/api/requests")).toBe(false);
  });
});

describe("review surface: tenant from headers (S04-01)", () => {
  it("accepts the x-org-id / x-property-id pair", () => {
    expect(tenantFromHeaders(reqWith({ "x-org-id": ORG, "x-property-id": PROP }))).toEqual({
      orgId: ORG,
      propertyId: PROP,
    });
  });

  it("refuses a missing or malformed pair instead of guessing", () => {
    expect(() => tenantFromHeaders(reqWith({}))).toThrow(ReviewInputError);
    expect(() => tenantFromHeaders(reqWith({ "x-org-id": ORG }))).toThrow(ReviewInputError);
    expect(() =>
      tenantFromHeaders(reqWith({ "x-org-id": "acme", "x-property-id": PROP })),
    ).toThrow(ReviewInputError);
  });
});

describe("review surface: ownership of the path (S04-01)", () => {
  it("claims /api/review and its children only", () => {
    expect(ownsReviewPath("/api/review")).toBe(true);
    expect(ownsReviewPath("/api/review/queue")).toBe(true);
    expect(ownsReviewPath("/api/reviews")).toBe(false);
    expect(ownsReviewPath("/healthz")).toBe(false);
  });
});

describe("analytics surface: status mapping and path ownership (S10-03)", () => {
  it("maps a bad date range to 400 and a missing property to 404", () => {
    expect(classifyError(new DashboardRangeError("from and to go together")).status).toBe(400);
    expect(classifyError(new DashboardPropertyNotFoundError("gone")).status).toBe(404);
  });

  it("claims /api/analytics and nothing that merely starts with it awkwardly", () => {
    expect(ownsAnalyticsPath("/api/analytics")).toBe(true);
    expect(ownsAnalyticsPath("/api/analytics/anything")).toBe(true);
    expect(ownsAnalyticsPath("/api/analyticsx")).toBe(false);
    expect(ownsAnalyticsPath("/api/inbox")).toBe(false);
  });
});
