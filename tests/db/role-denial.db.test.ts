/**
 * S02-06 / S04-01 — "each role can only reach its own surface", proven against
 * a real database and the real HTTP handler.
 *
 * The point of this file is the DENIAL half: the 403 must happen before any
 * business write, so every refused call is bracketed by counts of
 * `article_reviews`, `fact_resolutions`, `audit_log` and by the fact rows
 * themselves. A green matrix unit test (tests/auth/guard.test.ts) proves the
 * table; this proves the wiring a route actually uses.
 *
 * Roles come from `memberships` via `current_membership_role()` — the tokens
 * below are real signed JWTs (tests/auth/fixtures.ts) and carry no role claim,
 * so a change in the matrix cannot be smuggled in through the token.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import { verifyWithJwk, type StaffIdentity } from "../../src/auth/session.ts";
import { listContradictions } from "../../src/knowledge/facts.ts";
import { handleReviewRequest, type ReviewHttpDeps } from "../../src/staff/http.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

interface Person {
  key: string;
  email: string;
  neon: string;
  displayName: string;
  roleId: number;
  userUuid: string;
  token: string;
}

const KEY = ecKey("denial-key");

function person(key: string, roleId: number, email: string): Person {
  return {
    key,
    email,
    neon: `auth|denial-${key}`,
    displayName: key,
    roleId,
    userUuid: "",
    token: mint(
      KEY,
      liveClaims({ sub: `auth|denial-${key}`, email, name: key }),
    ),
  };
}

// role_id 1 owner, 2 manager, 3 front_desk, 4 observer (db/migrations/0001_init.sql)
const OWNER = person("owner", 1, "owner@denial-a.mx");
const MANAGER = person("manager", 2, "manager@denial-a.mx");
const FRONT_DESK = person("frontdesk", 3, "frontdesk@denial-a.mx");
const OBSERVER = person("observer", 4, "observer@denial-a.mx");
const STRANGER = person("stranger", 1, "stranger@nowhere.mx"); // no membership
const OWNER_B = person("owner_b", 1, "owner@denial-b.mx");

const PEOPLE = [OWNER, MANAGER, FRONT_DESK, OBSERVER, STRANGER, OWNER_B];

let client: pg.Client;
let ORG_A = "";
let PROP_A = "";
let ORG_B = "";
let PROP_B = "";
let VERSION_ID = "";
let FACT_HI = "";
let FACT_LO = "";
const CONTEXT_A = () => ({ orgId: ORG_A, propertyId: PROP_A });
const CONTEXT_B = () => ({ orgId: ORG_B, propertyId: PROP_B });

/** A real signature check, so the tests exercise the verifier seam for real. */
function identityFor(token: string): StaffIdentity {
  return verifyWithJwk(token, KEY.jwk as never, TEST_VERIFY);
}

function fakeReq(options: {
  method: string;
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
  body?: unknown;
}): IncomingMessage {
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  const headers: Record<string, string> = { host: "denial.test" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.context !== undefined) {
    headers["x-org-id"] = options.context.orgId;
    headers["x-property-id"] = options.context.propertyId;
  }
  return {
    method: options.method,
    url: options.url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield Buffer.from(payload);
    },
  } as unknown as IncomingMessage;
}

interface CapturedResponse {
  status: number;
  body: Record<string, unknown>;
}

function fakeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: {} };
  const res = {
    statusCode: 0,
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    setHeader() {},
    end(chunk?: unknown) {
      if (typeof chunk === "string" && chunk.length > 0) {
        captured.body = JSON.parse(chunk) as Record<string, unknown>;
      }
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function call(options: {
  method: string;
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
  body?: unknown;
  client?: pg.Client;
}): Promise<CapturedResponse> {
  const deps: ReviewHttpDeps = {
    client: options.client ?? client,
    verifyToken: async (token: string) => identityFor(token),
  };
  const { res, captured } = fakeRes();
  await handleReviewRequest(fakeReq(options), res, deps);
  return captured;
}

interface Counts {
  reviews: number;
  resolutions: number;
  audits: number;
  verifiedFacts: number;
}

async function counts(propertyId: string): Promise<Counts> {
  const result = await client.query<{
    reviews: string;
    resolutions: string;
    audits: string;
    verified: string;
  }>(
    `SELECT (SELECT count(*) FROM article_reviews WHERE property_id = $1) AS reviews,
            (SELECT count(*) FROM fact_resolutions WHERE property_id = $1) AS resolutions,
            (SELECT count(*) FROM audit_log WHERE property_id = $1) AS audits,
            (SELECT count(*) FROM property_facts WHERE property_id = $1 AND verified) AS verified`,
    [propertyId],
  );
  const row = result.rows[0]!;
  return {
    reviews: Number(row.reviews),
    resolutions: Number(row.resolutions),
    audits: Number(row.audits),
    verifiedFacts: Number(row.verified),
  };
}

describe("role denial on the first staff surface (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const orgA = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('denial_a', 'denial_a') RETURNING org_id",
    );
    ORG_A = orgA.rows[0]!.org_id;
    const propA = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug, time_zone) VALUES ($1, 'Denial A', 'denial_a', 'America/Mexico_City') RETURNING property_id",
      [ORG_A],
    );
    PROP_A = propA.rows[0]!.property_id;

    const orgB = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('denial_b', 'denial_b') RETURNING org_id",
    );
    ORG_B = orgB.rows[0]!.org_id;
    const propB = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Denial B', 'denial_b') RETURNING property_id",
      [ORG_B],
    );
    PROP_B = propB.rows[0]!.property_id;

    // One article version to approve, plus two contradicting facts to resolve.
    const source = await client.query<{ source_id: string }>(
      "INSERT INTO knowledge_sources (org_id, property_id, kind, title) VALUES ($1, $2, 'manual', 'Denial manual') RETURNING source_id",
      [ORG_A, PROP_A],
    );
    const article = await client.query<{ article_id: string }>(
      `INSERT INTO knowledge_articles (org_id, property_id, source_id, scope, topic_key, title, language)
       VALUES ($1, $2, $3, 'property', 'pool.hours', 'Pool hours', 'es') RETURNING article_id`,
      [ORG_A, PROP_A, source.rows[0]!.source_id],
    );
    const version = await client.query<{ article_version_id: string }>(
      `INSERT INTO article_versions (org_id, property_id, article_id, version_no, body)
       VALUES ($1, $2, $3, 1, 'La alberca cierra a las 21:00.') RETURNING article_version_id`,
      [ORG_A, PROP_A, article.rows[0]!.article_id],
    );
    VERSION_ID = version.rows[0]!.article_version_id;

    const facts = await client.query<{ fact_id: string; fact_value: string }>(
      `INSERT INTO property_facts
         (org_id, property_id, topic_key, fact_key, fact_value, language, unit, effective_from)
       VALUES ($1, $2, 'pool.hours', 'closing_time', '21:00', 'es', 'time-of-day', '2026-01-01'),
              ($1, $2, 'pool.hours', 'closing_time', '20:00', 'es', 'time-of-day', '2026-01-01')
       RETURNING fact_id, fact_value`,
      [ORG_A, PROP_A],
    );
    FACT_HI = facts.rows.find((row) => row.fact_value === "21:00")!.fact_id;
    FACT_LO = facts.rows.find((row) => row.fact_value === "20:00")!.fact_id;

    for (const member of PEOPLE) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE concierge_app");
        const provisioned = await client.query<{ user_id: string }>(
          "SELECT provision_user($1, $2, $3) AS user_id",
          [member.neon, member.email, member.displayName],
        );
        member.userUuid = provisioned.rows[0]!.user_id;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    for (const member of [OWNER, MANAGER, FRONT_DESK, OBSERVER]) {
      await client.query(
        "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, $3)",
        [member.userUuid, PROP_A, member.roleId],
      );
    }
    await client.query(
      "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 1)",
      [OWNER_B.userUuid, PROP_B],
    );
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("resolves the role from memberships, and no token carries authority", async () => {
    // current_membership_role() is anchored to app.current_user_id (0004), i.e.
    // to the session the handler establishes — never to a claim in the token.
    const observed: Array<[string, number | null]> = [];
    for (const member of [OWNER, MANAGER, FRONT_DESK, OBSERVER]) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [member.userUuid]);
        const role = await client.query<{ role: number | null }>(
          "SELECT current_membership_role($1) AS role",
          [PROP_A],
        );
        observed.push([member.key, role.rows[0]!.role]);
      } finally {
        await client.query("ROLLBACK");
      }
    }
    expect(observed).toEqual([
      ["owner", 1],
      ["manager", 2],
      ["frontdesk", 3],
      ["observer", 4],
    ]);
  });

  it("lets owner and manager approve, and records who decided", async () => {
    const ownerCall = await call({
      method: "POST",
      url: `/api/review/versions/${VERSION_ID}/approve`,
      token: OWNER.token,
      context: CONTEXT_A(),
    });
    expect(ownerCall.status).toBe(200);

    const review = await client.query<{
      status: string;
      reviewer_user_id: string;
      decided_at: Date | null;
      org_id: string;
    }>(
      "SELECT status, reviewer_user_id, decided_at, org_id FROM article_reviews WHERE article_version_id = $1",
      [VERSION_ID],
    );
    expect(review.rows[0]).toMatchObject({
      status: "approved",
      reviewer_user_id: OWNER.userUuid,
      org_id: ORG_A,
    });
    expect(review.rows[0]!.decided_at).not.toBeNull();

    const audit = await client.query<{ actor_user_id: string; action: string }>(
      "SELECT actor_user_id, action FROM audit_log WHERE property_id = $1 ORDER BY audit_id",
      [PROP_A],
    );
    expect(audit.rows).toEqual([
      { actor_user_id: OWNER.userUuid, action: "article.version_approved" },
    ]);

    // a re-decision moves the reviewer and the timestamp together
    const managerCall = await call({
      method: "POST",
      url: `/api/review/versions/${VERSION_ID}/approve`,
      token: MANAGER.token,
      context: CONTEXT_A(),
    });
    expect(managerCall.status).toBe(200);
    const again = await client.query<{ status: string; reviewer_user_id: string }>(
      "SELECT status, reviewer_user_id FROM article_reviews WHERE article_version_id = $1",
      [VERSION_ID],
    );
    expect(again.rows).toHaveLength(1);
    expect(again.rows[0]!.reviewer_user_id).toBe(MANAGER.userUuid);
  });

  it("an approval cannot be anonymous (the DB refuses a nameless decision)", async () => {
    await expect(
      client.query(
        `INSERT INTO article_reviews (org_id, property_id, article_version_id, status)
         VALUES ($1, $2, $3, 'approved')`,
        [ORG_A, PROP_A, VERSION_ID],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses front_desk and observer on the write surface with zero writes", async () => {
    const before = await counts(PROP_A);
    for (const denied of [FRONT_DESK, OBSERVER]) {
      const approve = await call({
        method: "POST",
        url: `/api/review/versions/${VERSION_ID}/approve`,
        token: denied.token,
        context: CONTEXT_A(),
      });
      expect(approve.status, denied.key).toBe(403);
      expect(approve.body["error"], denied.key).toBe("role_not_on_surface");

      const reject = await call({
        method: "POST",
        url: `/api/review/versions/${VERSION_ID}/reject`,
        token: denied.token,
        context: CONTEXT_A(),
      });
      expect(reject.status, denied.key).toBe(403);

      const resolve = await call({
        method: "POST",
        url: "/api/review/contradictions/resolve",
        token: denied.token,
        context: CONTEXT_A(),
        body: {
          topicKey: "pool.hours",
          factKey: "closing_time",
          language: "es",
          effectiveFrom: "2026-01-01",
          winnerFactId: FACT_HI,
        },
      });
      expect(resolve.status, denied.key).toBe(403);
    }

    // Nothing moved: no review, no resolution, no audit, no new verdict.
    expect(await counts(PROP_A)).toEqual(before);
  });

  it("still lets front_desk and observer READ the queue (the mode matters)", async () => {
    for (const reader of [FRONT_DESK, OBSERVER]) {
      const queue = await call({
        method: "GET",
        url: "/api/review/queue",
        token: reader.token,
        context: CONTEXT_A(),
      });
      expect(queue.status, reader.key).toBe(200);
      expect(Array.isArray(queue.body)).toBe(true);
    }
  });

  it("refuses a verified identity with no membership, and a foreign property", async () => {
    const before = await counts(PROP_A);
    const stranger = await call({
      method: "GET",
      url: "/api/review/queue",
      token: STRANGER.token,
      context: CONTEXT_A(),
    });
    expect(stranger.status).toBe(403);
    expect(stranger.body["error"]).toBe("no_membership");

    const beforeB = await counts(PROP_B);
    const crossTenant = await call({
      method: "POST",
      url: `/api/review/versions/${VERSION_ID}/approve`,
      token: OWNER_B.token,
      context: CONTEXT_B(),
    });
    // The version is not in B: the FK/RLS make it invisible, so B learns nothing.
    expect([403, 404]).toContain(crossTenant.status);

    expect(await counts(PROP_A)).toEqual(before);
    expect(await counts(PROP_B)).toEqual(beforeB);
  });

  it("refuses an unverified caller before touching anything", async () => {
    const before = await counts(PROP_A);
    const noToken = await call({ method: "GET", url: "/api/review/queue", context: CONTEXT_A() });
    expect(noToken.status).toBe(401);
    expect(noToken.body["error"]).toBe("unauthorized");

    const garbage = await call({
      method: "GET",
      url: "/api/review/queue",
      token: "not-a-jwt",
      context: CONTEXT_A(),
    });
    expect(garbage.status).toBe(401);
    expect(await counts(PROP_A)).toEqual(before);
  });

  it("requires a tenant in the request", async () => {
    const missing = await call({
      method: "GET",
      url: "/api/review/queue",
      token: OWNER.token,
    });
    expect(missing.status).toBe(400);
    expect(missing.body["error"]).toBe("invalid_request");
  });

  it("resolves a contradiction only for a human who may write knowledge", async () => {
    const groups = await call({
      method: "GET",
      url: "/api/review/queue",
      token: OWNER.token,
      context: CONTEXT_A(),
    });
    expect(groups.status).toBe(200);

    const before = await listContradictions(client, CONTEXT_A());
    expect(before).toHaveLength(1);

    const badWinner = await call({
      method: "POST",
      url: "/api/review/contradictions/resolve",
      token: OWNER.token,
      context: CONTEXT_A(),
      body: {
        topicKey: "pool.hours",
        factKey: "closing_time",
        language: "es",
        effectiveFrom: "2026-01-01",
        winnerFactId: VERSION_ID, // a version id, not a fact in the group
      },
    });
    expect(badWinner.status).toBe(400);
    expect(badWinner.body["error"]).toBe("invalid_request");

    const resolved = await call({
      method: "POST",
      url: "/api/review/contradictions/resolve",
      token: OWNER.token,
      context: CONTEXT_A(),
      body: {
        topicKey: "pool.hours",
        factKey: "closing_time",
        language: "es",
        effectiveFrom: "2026-01-01",
        winnerFactId: FACT_HI,
      },
    });
    expect(resolved.status).toBe(200);

    // exactly one value survives, and the group leaves the queue
    const facts = await client.query<{ fact_value: string; verified: boolean }>(
      "SELECT fact_value, verified FROM property_facts WHERE property_id = $1 ORDER BY fact_value",
      [PROP_A],
    );
    expect(facts.rows).toEqual([
      { fact_value: "20:00", verified: false },
      { fact_value: "21:00", verified: true },
    ]);
    expect(await listContradictions(client, CONTEXT_A())).toHaveLength(0);

    const resolution = await client.query<{
      winner_fact_id: string;
      resolved_by: string;
    }>("SELECT winner_fact_id, resolved_by FROM fact_resolutions WHERE property_id = $1", [PROP_A]);
    expect(resolution.rows[0]).toMatchObject({
      winner_fact_id: FACT_HI,
      resolved_by: OWNER.userUuid,
    });

    const audit = await client.query<{ action: string; entity_type: string }>(
      "SELECT action, entity_type FROM audit_log WHERE property_id = $1 AND action = 'fact.contradiction_resolved'",
      [PROP_A],
    );
    expect(audit.rows).toEqual([
      { action: "fact.contradiction_resolved", entity_type: "fact_group" },
    ]);

    // nothing left to resolve: the same call is a 404, not a silent success
    const twice = await call({
      method: "POST",
      url: "/api/review/contradictions/resolve",
      token: OWNER.token,
      context: CONTEXT_A(),
      body: {
        topicKey: "pool.hours",
        factKey: "closing_time",
        language: "es",
        effectiveFrom: "2026-01-01",
        winnerFactId: FACT_LO,
      },
    });
    expect(twice.status).toBe(404);
    expect(twice.body["error"]).toBe("not_found");
  });

  it("never serves the queue or a decision across tenants", async () => {
    // owner_b asks for property A's context: their token is valid but has no
    // membership here, so the transaction refuses before any SELECT.
    const queue = await call({
      method: "GET",
      url: "/api/review/queue",
      token: OWNER_B.token,
      context: CONTEXT_A(),
    });
    expect(queue.status).toBe(403);
    expect(queue.body["error"]).toBe("no_membership");
  });
});
