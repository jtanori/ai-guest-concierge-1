/**
 * S08-03 — the four staff actions, through the real HTTP pipeline.
 *
 * The race test (`tests/db/takeover-race.db.test.ts`) proves AC-2 with two
 * connections. This file proves the things a single caller can get wrong: the
 * message that a guest actually receives, the role that must not send it, the
 * assignment replay that must not double, and the cross-tenant id that must not
 * resolve somebody else's request.
 *
 * Everything goes through `handleInboxRequest` with a real signed JWT and a real
 * database, because the interesting failures here are "the route forgot
 * `requireRole`" and "the UPDATE forgot the tenant predicate" — neither of which
 * a service-level unit test can see.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import { verifyWithJwk, type StaffIdentity } from "../../src/auth/session.ts";
import { handleInboxRequest, type ReviewHttpDeps } from "../../src/staff/http.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const KEY = ecKey("actions-key");

interface Person {
  email: string;
  neon: string;
  roleId: number;
  userUuid: string;
  token: string;
}

function person(key: string, roleId: number, tenantKey: string): Person {
  const email = `${key}@${tenantKey}.mx`;
  return {
    email,
    neon: `auth|actions-${key}`,
    roleId,
    userUuid: "",
    token: mint(KEY, liveClaims({ sub: `auth|actions-${key}`, email, name: key })),
  };
}

// role_id 1 owner, 2 manager, 3 front_desk, 4 observer (0001)
const DESK = person("desk", 3, "a");
const MANAGER = person("manager", 2, "a");
const OBSERVER = person("observer", 4, "a");
const OWNER_B = person("owner_b", 1, "b");

let client: pg.Client;
let tenantA: { orgId: string; propertyId: string };
let tenantB: { orgId: string; propertyId: string };
let conversationId = "";
let foreignConversationId = "";

function identityFor(token: string): StaffIdentity {
  return verifyWithJwk(token, KEY.jwk as never, TEST_VERIFY);
}

function fakeReq(options: {
  method?: string;
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
  body?: unknown;
}): IncomingMessage {
  const headers: Record<string, string> = { host: "actions.test" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.context !== undefined) {
    headers["x-org-id"] = options.context.orgId;
    headers["x-property-id"] = options.context.propertyId;
  }
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  return {
    method: options.method ?? "GET",
    url: options.url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload !== "") yield Buffer.from(payload);
    },
  } as unknown as IncomingMessage;
}

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

async function call(options: {
  method?: string;
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
  body?: unknown;
}): Promise<Captured> {
  const captured: Captured = { status: 0, body: {} };
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
  const deps: ReviewHttpDeps = { client, verifyToken: async (token: string) => identityFor(token) };
  await handleInboxRequest(fakeReq(options), res, deps);
  return captured;
}

async function provision(member: Person, propertyId: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");
    const user = await client.query<{ user_id: string }>(
      "SELECT provision_user($1, $2, $3) AS user_id",
      [member.neon, member.email, member.email],
    );
    member.userUuid = user.rows[0]!.user_id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  await client.query("INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, $3)", [
    member.userUuid,
    propertyId,
    member.roleId,
  ]);
}

function post(path: string, body: unknown = {}, token = DESK.token): Promise<Captured> {
  return call({ method: "POST", url: `/api/inbox/conversations/${conversationId}/${path}`, token, context: tenantA, body });
}

describe("staff actions (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const a = await seedTenant(client, "actions_a");
    tenantA = { orgId: a.orgId, propertyId: a.propertyId };
    conversationId = a.conversationId;

    const b = await seedTenant(client, "actions_b");
    tenantB = { orgId: b.orgId, propertyId: b.propertyId };
    foreignConversationId = b.conversationId;

    for (const member of [DESK, MANAGER, OBSERVER]) await provision(member, tenantA.propertyId);
    await provision(OWNER_B, tenantB.propertyId);
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("reply writes a staff message and claims the thread (AC-1)", async () => {
    const first = await post("reply", { body: "  Con gusto, ya lo reviso.  " });
    expect(first.status).toBe(200);
    expect(first.body["aiState"]).toBe("awaiting_staff");

    const messages = await client.query<{ body: string; author_role: string; direction: string }>(
      `SELECT body, author_role, direction FROM messages
        WHERE conversation_id = $1 AND author_role = 'staff' ORDER BY created_at`,
      [conversationId],
    );
    // Trimmed, and stored as the staff member typed it — no model, no rewrite.
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]).toMatchObject({
      body: "Con gusto, ya lo reviso.",
      direction: "outbound",
    });

    const state = await client.query<{ ai_state: string }>(
      "SELECT ai_state FROM conversations WHERE conversation_id = $1",
      [conversationId],
    );
    expect(state.rows[0]!.ai_state).toBe("awaiting_staff");

    // A human claimed it, and the record says which human-shaped reason: not
    // `guest_asked_human`, which is a metric about guests.
    const handoff = await client.query<{ reason_code: string }>(
      "SELECT reason_code FROM handoff_reasons WHERE conversation_id = $1",
      [conversationId],
    );
    expect(handoff.rows.map((row) => row.reason_code)).toEqual(["staff_takeover"]);

    const audit = await client.query<{ action: string; actor_user_id: string }>(
      "SELECT action, actor_user_id FROM audit_log WHERE entity_id = $1 OR entity_id = $2 ORDER BY audit_id",
      [conversationId, (first.body["messageId"] as string) ?? ""],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(["conversation.takeover", "message.sent"]);
    expect(audit.rows.every((row) => row.actor_user_id === DESK.userUuid)).toBe(true);
  });

  it("a second reply appends instead of taking over again", async () => {
    const second = await post("reply", { body: "Listo, la habitación está preparada." }, MANAGER.token);
    expect(second.status).toBe(200);
    const handoffs = await client.query("SELECT 1 FROM handoff_reasons WHERE conversation_id = $1", [
      conversationId,
    ]);
    expect(handoffs.rowCount).toBe(1);
    const staff = await client.query("SELECT 1 FROM messages WHERE conversation_id = $1 AND author_role = 'staff'", [
      conversationId,
    ]);
    expect(staff.rowCount).toBe(2);
  });

  it("takeover is idempotent and says so", async () => {
    const again = await post("takeover");
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ aiState: "awaiting_staff", alreadyOwned: true });
  });

  it("the read-only observer cannot act", async () => {
    for (const action of ["reply", "takeover", "assign", "resolve"]) {
      const denied = await post(action, { body: "nope" }, OBSERVER.token);
      expect(denied.status).toBe(403);
      expect(denied.body["error"]).toBe("role_not_on_surface");
    }
  });

  it("assign defaults to the caller, and a replay is a no-op", async () => {
    const request = await client.query<{ request_id: string }>(
      `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status)
       VALUES ($1, $2, $3, 'needs_human', 'new') RETURNING request_id`,
      [tenantA.orgId, tenantA.propertyId, conversationId],
    );
    const requestId = request.rows[0]!.request_id;

    const first = await post("assign", { requestId });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ requestId, assignedTo: DESK.userUuid, created: true });

    // The same click, twice — a phone on a bad connection, not a second decision.
    const replay = await post("assign", { requestId });
    expect(replay.body).toMatchObject({ requestId, assignedTo: DESK.userUuid, created: false });

    const rows = await client.query("SELECT 1 FROM assignments WHERE request_id = $1", [requestId]);
    expect(rows.rowCount).toBe(1);
    const status = await client.query<{ status: string }>(
      "SELECT status FROM service_requests WHERE request_id = $1",
      [requestId],
    );
    expect(status.rows[0]!.status).toBe("assigned");
    const events = await client.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE payload->>'request_id' = $1",
      [requestId],
    );
    expect(events.rowCount).toBe(1);
  });

  it("refuses an assignee who is not on this property's staff", async () => {
    const outsider = await client.query<{ request_id: string }>(
      `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status)
       VALUES ($1, $2, $3, 'needs_human', 'new') RETURNING request_id`,
      [tenantA.orgId, tenantA.propertyId, conversationId],
    );
    const denied = await post("assign", {
      requestId: outsider.rows[0]!.request_id,
      assigneeUserId: OWNER_B.userUuid,
    });
    expect(denied.status).toBe(409);
    expect(denied.body["error"]).toBe("assignee_not_member");
  });

  it("resolve closes the conversation and its open request together (AC-1)", async () => {
    const resolved = await post("resolve");
    expect(resolved.status).toBe(200);
    expect(resolved.body["aiState"]).toBe("resolved");
    expect((resolved.body["requestIds"] as string[]).length).toBeGreaterThanOrEqual(2);

    const conversation = await client.query<{ ai_state: string }>(
      "SELECT ai_state FROM conversations WHERE conversation_id = $1",
      [conversationId],
    );
    expect(conversation.rows[0]!.ai_state).toBe("resolved");

    const open = await client.query(
      "SELECT 1 FROM service_requests WHERE conversation_id = $1 AND status <> 'resolved'",
      [conversationId],
    );
    expect(open.rowCount).toBe(0);
    const resolvedAt = await client.query(
      "SELECT 1 FROM service_requests WHERE conversation_id = $1 AND resolved_at IS NOT NULL",
      [conversationId],
    );
    expect(resolvedAt.rowCount).toBeGreaterThan(0);
  });

  it("cannot touch another tenant's conversation, and leaves it untouched", async () => {
    const before = await client.query<{ ai_state: string }>(
      "SELECT ai_state FROM conversations WHERE conversation_id = $1",
      [foreignConversationId],
    );
    for (const action of ["takeover", "reply", "resolve"]) {
      const denied = await call({
        method: "POST",
        url: `/api/inbox/conversations/${foreignConversationId}/${action}`,
        token: DESK.token,
        context: tenantA,
        body: { body: "hello" },
      });
      expect(denied.status).toBe(404);
      expect(denied.body["error"]).toBe("not_found");
    }
    // The owner of B is allowed, on B — the 404s above were about the tenant pair,
    // not about the id.
    const allowed = await call({
      method: "POST",
      url: `/api/inbox/conversations/${foreignConversationId}/takeover`,
      token: OWNER_B.token,
      context: tenantB,
    });
    expect(allowed.status).toBe(200);

    const after = await client.query<{ ai_state: string }>(
      "SELECT ai_state FROM conversations WHERE conversation_id = $1",
      [foreignConversationId],
    );
    expect(after.rows[0]!.ai_state).toBe("awaiting_staff");
    expect(before.rows[0]!.ai_state).not.toBe("awaiting_staff");
  });

  it("rejects an empty or oversized reply", async () => {
    const empty = await post("reply", { body: "   " });
    expect(empty.status).toBe(400);
    expect(empty.body["error"]).toBe("invalid_request");
    const huge = await post("reply", { body: "x".repeat(2001) });
    expect(huge.status).toBe(400);
  });
});
