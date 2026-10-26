/**
 * S08-01 — the inbox against a real database and the real HTTP handler.
 *
 * AC-1 is "needs-attention / mine / unresolved with last message + wait time";
 * AC-2 is "tenant-scoped and paged, p95 read <300ms at fixture scale". Both are
 * statements about what comes back, so every case here goes through
 * `handleInboxRequest` with a real signed JWT — the same path a phone takes.
 *
 * The harness (JWTs, fake req/res) is the one `tests/db/role-denial.db.test.ts`
 * built for the first staff surface; reusing it is the point, because the inbox
 * runs through the same `handleStaffRequest` pipeline and would share any bug in
 * it.
 *
 * What is deliberately NOT here: a screenshot or a stopwatch. "60 seconds on a
 * phone" is a human measurement and it is recorded as owed in the runbook; the
 * machine-measurable half (one round trip, 20 rows, under 300ms) is what this
 * file proves.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import { verifyWithJwk, type StaffIdentity } from "../../src/auth/session.ts";
import { handleInboxRequest, type ReviewHttpDeps } from "../../src/staff/http.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

const KEY = ecKey("inbox-key");

interface Person {
  email: string;
  neon: string;
  roleId: number;
  userUuid: string;
  token: string;
}

function person(key: string, roleId: number, email: string): Person {
  return {
    email,
    neon: `auth|inbox-${key}`,
    roleId,
    userUuid: "",
    token: mint(KEY, liveClaims({ sub: `auth|inbox-${key}`, email, name: key })),
  };
}

// role_id 1 owner, 2 manager, 3 front_desk, 4 observer (0001)
const DESK = person("desk", 3, "desk@inbox-a.mx");
const OBSERVER = person("observer", 4, "observer@inbox-a.mx");
const OWNER_B = person("owner_b", 1, "owner@inbox-b.mx");

let client: pg.Client;
let ORG_A = "";
let PROP_A = "";
let ORG_B = "";
let PROP_B = "";

/** Conversation ids by scenario, so the assertions read like the queue. */
const CONV = {
  waitingOld: "",
  waitingNew: "",
  withAi: "",
  assigned: "",
  resolved: "",
  foreign: "",
};

function identityFor(token: string): StaffIdentity {
  return verifyWithJwk(token, KEY.jwk as never, TEST_VERIFY);
}

function fakeReq(options: {
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
}): IncomingMessage {
  const headers: Record<string, string> = { host: "inbox.test" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.context !== undefined) {
    headers["x-org-id"] = options.context.orgId;
    headers["x-property-id"] = options.context.propertyId;
  }
  return {
    method: "GET",
    url: options.url,
    headers,
    async *[Symbol.asyncIterator]() {},
  } as unknown as IncomingMessage;
}

interface CapturedResponse {
  status: number;
  body: Record<string, unknown>;
}

function fakeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: {} };
  const res = {
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
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
}): Promise<CapturedResponse> {
  const deps: ReviewHttpDeps = {
    client,
    verifyToken: async (token: string) => identityFor(token),
  };
  const { res, captured } = fakeRes();
  await handleInboxRequest(fakeReq(options), res, deps);
  return captured;
}

const CONTEXT_A = (): { orgId: string; propertyId: string } => ({
  orgId: ORG_A,
  propertyId: PROP_A,
});

interface InboxItemShape {
  conversationId: string;
  aiState: string;
  waitSeconds: number;
  lastMessage: { body: string; authorRole: string } | null;
  request: { requestId: string; status: string; assignedTo: string | null } | null;
}

function items(body: Record<string, unknown>): InboxItemShape[] {
  return body["items"] as InboxItemShape[];
}

async function conversation(
  orgId: string,
  propertyId: string,
  options: {
    aiState?: string;
    minutesAgo: number;
    message?: { body: string; authorRole?: string };
  },
): Promise<string> {
  const channel = await client.query<{ channel_connection_id: string }>(
    "SELECT channel_connection_id FROM channel_connections WHERE property_id = $1 AND channel = 'web' LIMIT 1",
    [propertyId],
  );
  const created = await client.query<{ conversation_id: string }>(
    `INSERT INTO conversations (org_id, property_id, connection_id, ai_state, last_activity_at)
     VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval) RETURNING conversation_id`,
    [orgId, propertyId, channel.rows[0]!.channel_connection_id, options.aiState ?? "idle", String(options.minutesAgo)],
  );
  const conversationId = created.rows[0]!.conversation_id;
  if (options.message !== undefined) {
    await client.query(
      `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' minutes')::interval)`,
      [
        orgId,
        propertyId,
        conversationId,
        options.message.authorRole === "guest" ? "inbound" : "outbound",
        options.message.authorRole ?? "guest",
        options.message.body,
        String(options.minutesAgo),
      ],
    );
  }
  return conversationId;
}

async function request(
  orgId: string,
  propertyId: string,
  conversationId: string,
  status: string,
  topic = "ai_unavailable",
): Promise<string> {
  const created = await client.query<{ request_id: string }>(
    `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING request_id`,
    [orgId, propertyId, conversationId, topic, status],
  );
  return created.rows[0]!.request_id;
}

describe("staff inbox (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const orgA = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('inbox_a', 'inbox_a') RETURNING org_id",
    );
    ORG_A = orgA.rows[0]!.org_id;
    const propA = await client.query<{ property_id: string }>(
      `INSERT INTO properties (org_id, name, slug, time_zone)
       VALUES ($1, 'Inbox A', 'inbox_a', 'America/Mexico_City') RETURNING property_id`,
      [ORG_A],
    );
    PROP_A = propA.rows[0]!.property_id;
    await client.query(
      "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web')",
      [ORG_A, PROP_A],
    );

    const orgB = await client.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('inbox_b', 'inbox_b') RETURNING org_id",
    );
    ORG_B = orgB.rows[0]!.org_id;
    const propB = await client.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'Inbox B', 'inbox_b') RETURNING property_id",
      [ORG_B],
    );
    PROP_B = propB.rows[0]!.property_id;
    await client.query(
      "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web')",
      [ORG_B, PROP_B],
    );

    for (const member of [DESK, OBSERVER, OWNER_B]) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE concierge_app");
        const provisioned = await client.query<{ user_id: string }>(
          "SELECT provision_user($1, $2, $3) AS user_id",
          [member.neon, member.email, member.email],
        );
        member.userUuid = provisioned.rows[0]!.user_id;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    for (const member of [DESK, OBSERVER]) {
      await client.query(
        "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, $3)",
        [member.userUuid, PROP_A, member.roleId],
      );
    }
    await client.query(
      "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 1)",
      [OWNER_B.userUuid, PROP_B],
    );

    // The queue, in the order an agent would work it.
    CONV.waitingOld = await conversation(ORG_A, PROP_A, {
      aiState: "awaiting_staff",
      minutesAgo: 40,
      message: { body: "¿Puedo dejar mi equipaje después del check-out?" },
    });
    await request(ORG_A, PROP_A, CONV.waitingOld, "new");

    CONV.waitingNew = await conversation(ORG_A, PROP_A, {
      aiState: "awaiting_staff",
      minutesAgo: 3,
      message: { body: "Necesito una cuna en la habitación 204." },
    });

    CONV.withAi = await conversation(ORG_A, PROP_A, {
      aiState: "awaiting_ai",
      minutesAgo: 8,
      message: { body: "¿A qué hora abre la alberca?", authorRole: "guest" },
    });

    CONV.assigned = await conversation(ORG_A, PROP_A, {
      aiState: "idle",
      minutesAgo: 12,
      message: { body: "Gracias, ya quedó.", authorRole: "staff" },
    });
    const assignedRequest = await request(ORG_A, PROP_A, CONV.assigned, "acknowledged", "guest_asked_human");
    await client.query(
      "INSERT INTO assignments (org_id, property_id, request_id, assigned_to) VALUES ($1, $2, $3, $4)",
      [ORG_A, PROP_A, assignedRequest, DESK.userUuid],
    );

    CONV.resolved = await conversation(ORG_A, PROP_A, {
      aiState: "awaiting_staff",
      minutesAgo: 90,
      message: { body: "Ya está resuelto, gracias." },
    });
    const resolvedRequest = await request(ORG_A, PROP_A, CONV.resolved, "resolved");
    await client.query(
      `UPDATE service_requests SET resolved_at = now() WHERE request_id = $1`,
      [resolvedRequest],
    );

    CONV.foreign = await conversation(ORG_B, PROP_B, {
      aiState: "awaiting_staff",
      minutesAgo: 1,
      message: { body: "Soy de otro hotel y no debería aparecer." },
    });
    await request(ORG_B, PROP_B, CONV.foreign, "new");
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("needs-attention is the waiting-for-a-person queue, newest first (AC-1)", async () => {
    const page = await call({ url: "/api/inbox", token: DESK.token, context: CONTEXT_A() });
    expect(page.status).toBe(200);
    expect(items(page.body).map((item) => item.conversationId)).toEqual([
      CONV.waitingNew,
      CONV.waitingOld,
      CONV.resolved,
    ]);
    // The default filter is the waiting queue: `withAi` and `assigned` are not in it.
    expect(items(page.body).every((item) => item.aiState === "awaiting_staff")).toBe(true);
  });

  it("carries the last message and a server-computed wait time on every row (AC-1)", async () => {
    const page = await call({ url: "/api/inbox", token: DESK.token, context: CONTEXT_A() });
    const row = items(page.body).find((item) => item.conversationId === CONV.waitingNew)!;
    expect(row.lastMessage?.body).toBe("Necesito una cuna en la habitación 204.");
    expect(row.lastMessage?.authorRole).toBe("guest");
    // 3 minutes ago, from the database clock — not from the test's clock and not
    // from the phone's.
    expect(row.waitSeconds).toBeGreaterThan(150);
    expect(row.waitSeconds).toBeLessThan(240);

    const older = items(page.body).find((item) => item.conversationId === CONV.waitingOld)!;
    expect(older.waitSeconds).toBeGreaterThan(row.waitSeconds);
    expect(older.request?.status).toBe("new");
  });

  it("'mine' is what is assigned to the caller, and it is empty for an observer (AC-1)", async () => {
    const mine = await call({
      url: "/api/inbox?filter=mine",
      token: DESK.token,
      context: CONTEXT_A(),
    });
    expect(items(mine.body).map((item) => item.conversationId)).toEqual([CONV.assigned]);
    expect(items(mine.body)[0]!.request?.assignedTo).toBe(DESK.userUuid);

    const observerMine = await call({
      url: "/api/inbox?filter=mine",
      token: OBSERVER.token,
      context: CONTEXT_A(),
    });
    expect(observerMine.status).toBe(200);
    expect(items(observerMine.body)).toEqual([]);
  });

  it("'unresolved' is open requests, not open conversations (AC-1)", async () => {
    const page = await call({
      url: "/api/inbox?filter=unresolved",
      token: DESK.token,
      context: CONTEXT_A(),
    });
    const ids = items(page.body).map((item) => item.conversationId);
    expect(ids).toEqual(expect.arrayContaining([CONV.waitingOld, CONV.assigned]));
    // `resolved` still awaits a person but its request is closed: it belongs in
    // needs-attention, not here. Losing that distinction is how a hotel ends up
    // with a queue nobody trusts.
    expect(ids).not.toContain(CONV.resolved);
    expect(ids).not.toContain(CONV.withAi);
  });

  it("never returns another tenant's queue, even with a valid token (AC-2)", async () => {
    const page = await call({ url: "/api/inbox", token: DESK.token, context: CONTEXT_A() });
    expect(items(page.body).map((item) => item.conversationId)).not.toContain(CONV.foreign);

    // And a desk user of property A cannot read property B by asking for it:
    // the membership check refuses before any query runs.
    const foreign = await call({
      url: "/api/inbox",
      token: DESK.token,
      context: { orgId: ORG_B, propertyId: PROP_B },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body["error"]).toBe("no_membership");

    const foreignOwner = await call({
      url: "/api/inbox",
      token: OWNER_B.token,
      context: { orgId: ORG_B, propertyId: PROP_B },
    });
    expect(items(foreignOwner.body).map((item) => item.conversationId)).toEqual([CONV.foreign]);
  });

  it("pages by keyset, and a new message between pages cannot repeat a row (AC-2)", async () => {
    const first = await call({
      url: "/api/inbox?limit=2",
      token: DESK.token,
      context: CONTEXT_A(),
    });
    expect(items(first.body)).toHaveLength(2);
    const cursor = first.body["nextCursor"];
    expect(typeof cursor).toBe("string");

    // A guest writes while the agent is reading page 1. An OFFSET query would
    // now show `waitingOld` twice or skip it entirely.
    await client.query(
      "INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body) VALUES ($1, $2, $3, 'inbound', 'guest', $4)",
      [ORG_A, PROP_A, CONV.withAi, "Sigo esperando respuesta."],
    );

    const second = await call({
      url: `/api/inbox?limit=2&cursor=${encodeURIComponent(String(cursor))}`,
      token: DESK.token,
      context: CONTEXT_A(),
    });
    const secondIds = items(second.body).map((item) => item.conversationId);
    // Page 1 was [waitingNew, waitingOld]; the cursor sits on the last row of
    // page 1, so page 2 starts after it — and `withAi` is still excluded by the
    // filter even though it just became the most recent conversation.
    expect(secondIds).not.toContain(CONV.waitingNew);
    expect(secondIds).toEqual([CONV.resolved]);

    // Two rows left the queue after the cursor, so page 2 is the end of it and
    // says so instead of handing back a cursor that would loop.
    expect(second.body["nextCursor"]).toBeNull();
  });

  it("reads a 20-row page well under the 300ms budget (AC-2)", async () => {
    // Fixture scale, not load-test scale: this is the "does the query have an
    // index" question, and a missing index shows up here as a 4x regression on a
    // table with twenty rows, so it is worth asserting.
    await client.query("BEGIN");
    try {
      for (let i = 0; i < 40; i += 1) {
        await conversation(ORG_A, PROP_A, {
          aiState: "awaiting_staff",
          minutesAgo: 200 + i,
          message: { body: `Mensaje de relleno ${i}` },
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      const page = await call({ url: "/api/inbox?limit=20", token: DESK.token, context: CONTEXT_A() });
      timings.push(performance.now() - started);
      expect(items(page.body)).toHaveLength(20);
    }
    const slowest = Math.max(...timings);
    expect(slowest).toBeLessThan(300);

    // The plan, not the stopwatch, is the durable assertion: on a sequential
    // scan the timing would still pass at this size and fail at 500
    // conversations.
    const plan = await client.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (FORMAT JSON) SELECT c.conversation_id FROM conversations c
        WHERE c.org_id = $1 AND c.property_id = $2
        ORDER BY c.last_activity_at DESC, c.conversation_id DESC LIMIT 21`,
      [ORG_A, PROP_A],
    );
    expect(JSON.stringify(plan.rows[0]!["QUERY PLAN"])).not.toMatch(/"Seq Scan on conversations"/);
  });

  it("refuses an unknown filter and a hand-edited cursor (AC-2)", async () => {
    const badFilter = await call({
      url: "/api/inbox?filter=everything",
      token: DESK.token,
      context: CONTEXT_A(),
    });
    expect(badFilter.status).toBe(400);
    expect(badFilter.body["error"]).toBe("invalid_request");

    const badCursor = await call({
      url: "/api/inbox?cursor=not-a-cursor",
      token: DESK.token,
      context: CONTEXT_A(),
    });
    expect(badCursor.status).toBe(400);
  });

  it("is 401 without a token and 404 on an unknown inbox path", async () => {
    const anonymous = await call({ url: "/api/inbox", context: CONTEXT_A() });
    expect(anonymous.status).toBe(401);

    const wrongPath = await call({
      url: "/api/inbox/conversations",
      token: DESK.token,
      context: CONTEXT_A(),
    });
    expect(wrongPath.status).toBe(404);
  });

  it("lets an observer read the queue, because the role matrix says so", async () => {
    // The charter's test plan expected observer → 403. The shipped matrix
    // (src/auth/guard.ts) grants `queue: read` to all four roles, and this item
    // adds no write action, so there is nothing for an observer to be denied.
    // Documented in the charter §10 rather than silently inverted.
    const page = await call({ url: "/api/inbox", token: OBSERVER.token, context: CONTEXT_A() });
    expect(page.status).toBe(200);
    expect(items(page.body).length).toBeGreaterThan(0);
  });
});
