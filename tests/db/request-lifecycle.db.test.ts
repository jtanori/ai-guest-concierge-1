/**
 * S09-01 — the request lifecycle, enforced by the database.
 *
 * The service in `src/requests/lifecycle.ts` already refuses an illegal edge,
 * and `tests/requests/lifecycle.test.ts` proves that. This file exists because
 * a TypeScript refusal is only a refusal for callers that go through the
 * TypeScript: the AC is that the machine lives in the database, so the
 * interesting assertions here are the ones made with a **raw UPDATE** that never
 * imports the service — the shape a background job, a future endpoint nobody has
 * reviewed, or a psql session would take.
 *
 * The second thing only a database test can see is *who* walked the edge. "The
 * acknowledgement came from a real queue-write staff action" is a claim about the
 * actor GUC and the membership role, and both are invisible to a unit test.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import { verifyWithJwk, type StaffIdentity } from "../../src/auth/session.ts";
import { handleInboxRequest, type ReviewHttpDeps } from "../../src/staff/http.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const KEY = ecKey("lifecycle-key");

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
    neon: `auth|lifecycle-${key}`,
    roleId,
    userUuid: "",
    token: mint(KEY, liveClaims({ sub: `auth|lifecycle-${key}`, email, name: key })),
  };
}

// role_id 1 owner, 2 manager, 3 front_desk, 4 observer (0001)
const OWNER = person("owner", 1, "a");
const MANAGER = person("manager", 2, "a");
const DESK = person("desk", 3, "a");
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

/** A fresh request on tenant A's conversation, born `new` like every real one. */
async function newRequest(): Promise<string> {
  const created = await client.query<{ request_id: string }>(
    `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status)
     VALUES ($1, $2, $3, 'needs_human', 'new') RETURNING request_id`,
    [tenantA.orgId, tenantA.propertyId, conversationId],
  );
  return created.rows[0]!.request_id;
}

interface Attempt {
  ok: boolean;
  code?: string;
}

/**
 * One raw UPDATE, as `concierge_app`, inside a real staff-shaped transaction.
 *
 * This is the caller the guard exists for: no service, no `requireRole`, no
 * endpoint. Only the GUCs a session would have set — and, in the cases that
 * matter, deliberately *not* all of them.
 */
async function rawUpdate(
  requestId: string,
  set: string,
  params: unknown[],
  options: { actor?: string | null; role?: "app" | "superuser"; tenant?: { orgId: string; propertyId: string } } = {},
): Promise<Attempt> {
  const tenant = options.tenant ?? tenantA;
  const role = options.role ?? "app";
  await client.query("BEGIN");
  try {
    if (role === "app") await client.query("SET LOCAL ROLE concierge_app");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenant.orgId]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [tenant.propertyId]);
    if (options.actor !== null && options.actor !== undefined) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [options.actor]);
    }
    await client.query(
      `UPDATE service_requests SET ${set}
        WHERE org_id = $1 AND property_id = $2 AND request_id = $3`,
      [tenant.orgId, tenant.propertyId, requestId, ...params],
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    return { ok: false, code: (error as { code?: string }).code };
  }
}

async function statusOf(requestId: string): Promise<string> {
  const row = await client.query<{ status: string }>(
    "SELECT status FROM service_requests WHERE request_id = $1",
    [requestId],
  );
  return row.rows[0]?.status ?? "(gone)";
}

/** Walk the legal edges up to `target`, so a test can start mid-machine. */
async function advanceTo(requestId: string, target: "acknowledged" | "assigned" | "resolved" | "cancelled"): Promise<void> {
  const order = ["acknowledged", "assigned", "resolved", "cancelled"] as const;
  const stop = order.indexOf(target);
  expect(stop, target).toBeGreaterThanOrEqual(0);
  for (let i = 0; i <= stop; i += 1) {
    const step = order[i]!;
    // `resolved` and `cancelled` are both reachable only from `assigned`; a
    // caller walking to `resolved` never passes through `cancelled`.
    if (i === 2 && target === "cancelled") continue;
    if (i === 3 && target !== "cancelled") continue;
    const attempt = await legalEdge(requestId, step);
    expect(attempt, `${step} while advancing to ${target}`).toMatchObject({ ok: true });
  }
}

/** The UPDATE a correct caller makes for one legal edge, evidence included. */
async function legalEdge(
  requestId: string,
  to: "acknowledged" | "assigned" | "resolved" | "cancelled",
  actor: Person = DESK,
): Promise<Attempt> {
  if (to === "assigned") {
    // The caller inserts the assignment first, in the same transaction. Done
    // here as superuser so the edge under test is the only thing that can fail.
    await client.query(
      `INSERT INTO assignments (org_id, property_id, request_id, assigned_to)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, property_id, request_id, assigned_to) DO NOTHING`,
      [tenantA.orgId, tenantA.propertyId, requestId, actor.userUuid],
    );
  }
  const set =
    to === "acknowledged"
      ? "status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $4::uuid"
      : to === "resolved"
        ? "status = 'resolved', resolved_at = now()"
        : `status = '${to}'`;
  return rawUpdate(requestId, set, to === "acknowledged" ? [actor.userUuid] : [], {
    actor: actor.userUuid,
  });
}

/* ------------------------------- HTTP layer ------------------------------- */

function fakeReq(options: {
  method?: string;
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
  body?: unknown;
}): IncomingMessage {
  const headers: Record<string, string> = { host: "lifecycle.test" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.context !== undefined) {
    headers["x-org-id"] = options.context.orgId;
    headers["x-property-id"] = options.context.propertyId;
  }
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  return {
    method: options.method ?? "POST",
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

function edge(requestId: string, action: string, token = DESK.token, body: unknown = {}): Promise<Captured> {
  return call({
    url: `/api/inbox/requests/${requestId}/${action}`,
    token,
    context: tenantA,
    body,
  });
}

/* --------------------------------- suite --------------------------------- */

describe("request lifecycle (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const a = await seedTenant(client, "lifecycle_a");
    tenantA = { orgId: a.orgId, propertyId: a.propertyId };
    conversationId = a.conversationId;

    const b = await seedTenant(client, "lifecycle_b");
    tenantB = { orgId: b.orgId, propertyId: b.propertyId };
    foreignConversationId = b.conversationId;

    for (const member of [OWNER, MANAGER, DESK, OBSERVER]) await provision(member, tenantA.propertyId);
    await provision(OWNER_B, tenantB.propertyId);
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  describe("AC-1 — the matrix is in the database, not in the endpoint", () => {
    // Every pair that is NOT an edge. Each is attempted by a *valid* queue-write
    // actor, so the only thing that can refuse it is the guard.
    const ILLEGAL: Array<[string, string]> = [
      ["new", "assigned"],
      ["new", "resolved"],
      ["new", "cancelled"],
      ["acknowledged", "resolved"],
      ["acknowledged", "cancelled"],
      ["resolved", "new"],
      ["resolved", "acknowledged"],
      ["resolved", "assigned"],
      ["resolved", "cancelled"],
      ["cancelled", "new"],
      ["cancelled", "acknowledged"],
      ["cancelled", "assigned"],
      ["cancelled", "resolved"],
    ];

    for (const [from, to] of ILLEGAL) {
      it(`refuses ${from} → ${to} (23514)`, async () => {
        const requestId = await newRequest();
        if (from !== "new") await advanceTo(requestId, from as "acknowledged");
        expect(await statusOf(requestId)).toBe(from);

        const attempt = await rawUpdate(requestId, `status = '${to}'`, [], { actor: DESK.userUuid });
        expect(attempt).toMatchObject({ ok: false, code: "23514" });
        // Refused means not written: the row is still where it was.
        expect(await statusOf(requestId)).toBe(from);
      });
    }

    it("walks new → acknowledged → assigned → resolved, one legal edge at a time", async () => {
      const requestId = await newRequest();
      for (const step of ["acknowledged", "assigned", "resolved"] as const) {
        expect(await legalEdge(requestId, step), step).toMatchObject({ ok: true });
        expect(await statusOf(requestId)).toBe(step);
      }
    });

    it("walks assigned → cancelled", async () => {
      const requestId = await newRequest();
      await advanceTo(requestId, "assigned");
      expect(await legalEdge(requestId, "cancelled")).toMatchObject({ ok: true });
      expect(await statusOf(requestId)).toBe("cancelled");
    });

    it("lets any of the three queue-write roles walk an edge", async () => {
      for (const actor of [OWNER, MANAGER, DESK]) {
        const requestId = await newRequest();
        expect(await legalEdge(requestId, "acknowledged", actor), actor.email).toMatchObject({
          ok: true,
        });
        expect(await statusOf(requestId)).toBe("acknowledged");
      }
    });
  });

  describe("AC-2 — acknowledgement comes from a real queue-write staff action", () => {
    it("refuses an acknowledgement with no actor in the session (42501)", async () => {
      const requestId = await newRequest();
      // A background job or a script: tenant context present, nobody signed in.
      const attempt = await rawUpdate(
        requestId,
        "status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $4::uuid",
        [DESK.userUuid],
        { actor: null },
      );
      expect(attempt).toMatchObject({ ok: false, code: "42501" });
      expect(await statusOf(requestId)).toBe("new");
    });

    it("refuses the read-only observer, who passes RLS but holds no queue:write (42501)", async () => {
      const requestId = await newRequest();
      const attempt = await rawUpdate(
        requestId,
        "status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $4::uuid",
        [OBSERVER.userUuid],
        { actor: OBSERVER.userUuid },
      );
      expect(attempt).toMatchObject({ ok: false, code: "42501" });
      expect(await statusOf(requestId)).toBe("new");
    });

    it("refuses every edge for the observer, not just acknowledgement", async () => {
      const requestId = await newRequest();
      await advanceTo(requestId, "assigned"); // walked by DESK
      for (const to of ["resolved", "cancelled"]) {
        const attempt = await rawUpdate(requestId, `status = '${to}', resolved_at = now()`, [], {
          actor: OBSERVER.userUuid,
        });
        expect(attempt, to).toMatchObject({ ok: false, code: "42501" });
      }
      expect(await statusOf(requestId)).toBe("assigned");
    });

    it("refuses an acknowledgement that names somebody other than the actor", async () => {
      const requestId = await newRequest();
      // DESK is signed in but stamps MANAGER as the acknowledger: the audit trail
      // would credit a person who did nothing.
      const attempt = await rawUpdate(
        requestId,
        "status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $4::uuid",
        [MANAGER.userUuid],
        { actor: DESK.userUuid },
      );
      expect(attempt).toMatchObject({ ok: false, code: "23514" });
      expect(await statusOf(requestId)).toBe("new");
    });

    it("refuses an acknowledgement with no timestamp behind it", async () => {
      const requestId = await newRequest();
      const attempt = await rawUpdate(requestId, "status = 'acknowledged', acknowledged_by = $4::uuid", [
        DESK.userUuid,
      ], { actor: DESK.userUuid });
      expect(attempt).toMatchObject({ ok: false, code: "23514" });
      expect(await statusOf(requestId)).toBe("new");
    });

    it("stamps the actor who actually acknowledged", async () => {
      const requestId = await newRequest();
      expect(await legalEdge(requestId, "acknowledged", MANAGER)).toMatchObject({ ok: true });
      const row = await client.query<{ acknowledged_by: string }>(
        "SELECT acknowledged_by FROM service_requests WHERE request_id = $1",
        [requestId],
      );
      expect(row.rows[0]!.acknowledged_by).toBe(MANAGER.userUuid);
    });

    it("refuses a staff member of a different property, whose GUC does not match the row", async () => {
      const requestId = await newRequest();
      // OWNER_B is a real owner — of tenant B. Under tenant A's context the row
      // is not even visible to them, so the write changes nothing.
      const attempt = await rawUpdate(requestId, "status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $4::uuid", [
        OWNER_B.userUuid,
      ], { actor: OWNER_B.userUuid });
      expect(attempt.ok).toBe(false);
      expect(await statusOf(requestId)).toBe("new");
    });
  });

  describe("AC-1 — each edge has to carry its own evidence", () => {
    it("refuses `assigned` with no assignments row", async () => {
      const requestId = await newRequest();
      await advanceTo(requestId, "acknowledged");
      const attempt = await rawUpdate(requestId, "status = 'assigned'", [], { actor: DESK.userUuid });
      expect(attempt).toMatchObject({ ok: false, code: "23514" });
      expect(await statusOf(requestId)).toBe("acknowledged");
    });

    it("refuses `resolved` with no resolved_at", async () => {
      const requestId = await newRequest();
      await advanceTo(requestId, "assigned");
      const attempt = await rawUpdate(requestId, "status = 'resolved'", [], { actor: DESK.userUuid });
      expect(attempt).toMatchObject({ ok: false, code: "23514" });
      expect(await statusOf(requestId)).toBe("assigned");
    });

    it("refuses a row born claiming an acknowledger while still new (0018's family, P0001)", async () => {
      const attempt = await client
        .query(
          `INSERT INTO service_requests
             (org_id, property_id, conversation_id, topic, status, acknowledged_by)
           VALUES ($1, $2, $3, 'needs_human', 'new', $4)`,
          [tenantA.orgId, tenantA.propertyId, conversationId, DESK.userUuid],
        )
        .then(
          () => ({ ok: true }) as Attempt,
          (error: unknown) => ({ ok: false, code: (error as { code?: string }).code }) as Attempt,
        );
      expect(attempt).toMatchObject({ ok: false, code: "P0001" });
    });

    it("refuses moving a request to another property", async () => {
      const requestId = await newRequest();
      const attempt = await rawUpdate(requestId, "property_id = $4::uuid", [tenantB.propertyId], {
        actor: DESK.userUuid,
      });
      expect(attempt).toMatchObject({ ok: false, code: "23514" });
    });
  });

  describe("AC-3 — the canonical events, through the real endpoint", () => {
    it("emits request_acknowledged, request_assigned and request_resolved in order", async () => {
      const requestId = await newRequest();

      const acknowledged = await edge(requestId, "acknowledge", MANAGER.token);
      expect(acknowledged.status).toBe(200);
      expect(acknowledged.body).toMatchObject({ status: "acknowledged", changed: true });

      const assigned = await edge(requestId, "assign", DESK.token);
      expect(assigned.status).toBe(200);

      const resolved = await edge(requestId, "resolve");
      expect(resolved.status).toBe(200);

      const events = await client.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM events
          WHERE payload->>'request_id' = $1 ORDER BY created_at, event_id`,
        [requestId],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        "request_acknowledged",
        "request_assigned",
        "request_resolved",
      ]);
      // The acknowledgement names the person who made it, not the endpoint.
      expect(events.rows[0]!.payload).toMatchObject({ actor_user_id: MANAGER.userUuid });
      expect(events.rows[1]!.payload).toMatchObject({ assigned_to: DESK.userUuid });
    });

    it("audits every edge, and cancellation too", async () => {
      const requestId = await newRequest();
      await edge(requestId, "acknowledge");
      await edge(requestId, "assign");
      const cancelled = await edge(requestId, "cancel", OWNER.token);
      expect(cancelled.status).toBe(200);

      const audit = await client.query<{ action: string; actor_user_id: string; detail: Record<string, unknown> }>(
        `SELECT action, actor_user_id, detail FROM audit_log
          WHERE entity_type = 'request' AND entity_id = $1 ORDER BY audit_id`,
        [requestId],
      );
      // S09-05 adds a second row on the acknowledged edge only: the transition is
      // audited, then the escalation email is queued and that is audited too, in the
      // same transaction. `assigned` and `cancelled` queue nothing — emailing every
      // status change would turn the escalation channel into noise.
      expect(audit.rows.map((row) => row.action)).toEqual([
        "request.acknowledged",
        "notification.queued",
        "request.assigned",
        "request.cancelled",
      ]);
      expect(audit.rows.map((row) => row.actor_user_id)).toEqual([
        DESK.userUuid,
        DESK.userUuid,
        DESK.userUuid,
        OWNER.userUuid,
      ]);
      // The audit row is the history the status column cannot keep.
      expect(audit.rows[0]!.detail).toMatchObject({ previous: "new", status: "acknowledged" });
    });

    it("a replayed edge is a no-op that writes nothing a second time", async () => {
      const requestId = await newRequest();
      expect((await edge(requestId, "acknowledge")).body).toMatchObject({ changed: true });
      const replay = await edge(requestId, "acknowledge");
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ status: "acknowledged", changed: false });

      const events = await client.query(
        `SELECT 1 FROM events WHERE payload->>'request_id' = $1 AND event_type = 'request_acknowledged'`,
        [requestId],
      );
      expect(events.rowCount).toBe(1);
    });
  });

  describe("the endpoint refuses what the machine refuses", () => {
    it("is 401 without a token", async () => {
      const requestId = await newRequest();
      const anonymous = await call({
        url: `/api/inbox/requests/${requestId}/acknowledge`,
        context: tenantA,
        body: {},
      });
      expect(anonymous.status).toBe(401);
      expect(await statusOf(requestId)).toBe("new");
    });

    it("is 403 for the read-only observer", async () => {
      const requestId = await newRequest();
      for (const action of ["acknowledge", "assign", "resolve", "cancel"]) {
        const denied = await edge(requestId, action, OBSERVER.token);
        expect(denied.status, action).toBe(403);
        expect(denied.body["error"], action).toBe("role_not_on_surface");
      }
      expect(await statusOf(requestId)).toBe("new");
    });

    it("is 404 for a request that does not exist, and for another tenant's", async () => {
      const missing = await edge("00000000-0000-4000-8000-000000000009", "acknowledge");
      expect(missing.status).toBe(404);

      const foreign = await client.query<{ request_id: string }>(
        `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status)
         VALUES ($1, $2, $3, 'needs_human', 'new') RETURNING request_id`,
        [tenantB.orgId, tenantB.propertyId, foreignConversationId],
      );
      // A valid id, correctly shaped, belonging to somebody else: 404, never 403 —
      // the same reason the guest surface does not distinguish the two.
      const denied = await edge(foreign.rows[0]!.request_id, "acknowledge");
      expect(denied.status).toBe(404);
      expect(await statusOf(foreign.rows[0]!.request_id)).toBe("new");
    });

    it("is 409 when the caller skips an edge", async () => {
      const requestId = await newRequest();
      const skipped = await edge(requestId, "resolve");
      expect(skipped.status).toBe(409);
      expect(skipped.body["error"]).toBe("request_transition_conflict");
      expect(await statusOf(requestId)).toBe("new");
    });

    it("is 400 for an assignee that is not a uuid", async () => {
      const requestId = await newRequest();
      await edge(requestId, "acknowledge");
      const bad = await edge(requestId, "assign", DESK.token, { assigneeUserId: "not-a-uuid" });
      expect(bad.status).toBe(400);
      expect(bad.body["error"]).toBe("invalid_request");
    });

    it("refuses an assignee who is not on this property's staff", async () => {
      const requestId = await newRequest();
      await edge(requestId, "acknowledge");
      const outsider = await edge(requestId, "assign", DESK.token, {
        assigneeUserId: OWNER_B.userUuid,
      });
      expect(outsider.status).toBe(409);
      expect(await statusOf(requestId)).toBe("acknowledged");
    });
  });
});
