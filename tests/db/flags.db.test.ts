/**
 * S09-03 — "wrong or outdated", attributable to the run.
 *
 * The AC is one sentence about attribution, so the assertions here are about what
 * a flag *points at* and what stops it pointing at the wrong thing: a foreign run
 * id must be indistinguishable from a nonexistent one, the composite FK must
 * refuse the reference even when the application layer is bypassed entirely, and a
 * second click from the same person must not become a second opinion.
 *
 * Everything goes through the real HTTP route with a signed JWT and a real
 * database, because the interesting failures are "the route forgot requireRole"
 * and "the INSERT forgot the tenant predicate" — neither of which a service-level
 * unit test can see.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import { verifyWithJwk, type StaffIdentity } from "../../src/auth/session.ts";
import { handleInboxRequest, type ReviewHttpDeps } from "../../src/staff/http.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const KEY = ecKey("flags-key");
const LONG_NOTE = "x".repeat(2001);

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
    neon: `auth|flags-${key}`,
    roleId,
    userUuid: "",
    token: mint(KEY, liveClaims({ sub: `auth|flags-${key}`, email, name: key })),
  };
}

// role_id 1 owner, 2 manager, 3 front_desk, 4 observer (0001)
const OWNER = person("owner", 1, "a");
const DESK = person("desk", 3, "a");
const DESK2 = person("desk2", 3, "a");
const OBSERVER = person("observer", 4, "a");
const OWNER_B = person("owner_b", 1, "b");

let client: pg.Client;
let tenantA: { orgId: string; propertyId: string };
let tenantB: { orgId: string; propertyId: string };
let conversationId = "";
let aiRunId = "";
let messageId = "";
let foreignConversationId = "";
let foreignAiRunId = "";

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

/** One AI answer, with the run behind it — the thing a flag has to name. */
async function seedAnswer(tenant: { orgId: string; propertyId: string }, conv: string) {
  const message = await client.query<{ message_id: string }>(
    `INSERT INTO messages
       (org_id, property_id, conversation_id, direction, author_role, body, language)
     VALUES ($1, $2, $3, 'outbound', 'ai', 'La alberca abre a las 07:00.', 'es')
     RETURNING message_id`,
    [tenant.orgId, tenant.propertyId, conv],
  );
  const run = await client.query<{ ai_run_id: string }>(
    `INSERT INTO ai_runs
       (org_id, property_id, conversation_id, message_id, model_id, prompt_version, decision)
     VALUES ($1, $2, $3, $4, 'stub-model-2026-01-01', 'v1', 'answer')
     RETURNING ai_run_id`,
    [tenant.orgId, tenant.propertyId, conv, message.rows[0]!.message_id],
  );
  return { messageId: message.rows[0]!.message_id, aiRunId: run.rows[0]!.ai_run_id };
}

/* ------------------------------- HTTP layer ------------------------------- */

function fakeReq(options: {
  method?: string;
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
  body?: unknown;
}): IncomingMessage {
  const headers: Record<string, string> = { host: "flags.test" };
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

function flag(runId: string, token: string, body: unknown = {}, context = tenantA) {
  return call({ url: `/api/inbox/answers/${runId}/flag`, token, body, context });
}

async function detail(token: string, conv = conversationId, context = tenantA) {
  return call({ method: "GET", url: `/api/inbox/conversations/${conv}`, token, context });
}

interface FlagRow {
  flag_id: string;
  ai_run_id: string;
  flagged_by: string;
  note: string | null;
}

async function flagsFor(runId: string): Promise<FlagRow[]> {
  const rows = await client.query<FlagRow>(
    "SELECT flag_id, ai_run_id, flagged_by, note FROM answer_flags WHERE ai_run_id = $1 ORDER BY created_at, flag_id",
    [runId],
  );
  return rows.rows;
}

async function eventCount(runId: string): Promise<number> {
  const rows = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events
      WHERE event_type = 'answer_flagged_wrong' AND payload->>'ai_run_id' = $1`,
    [runId],
  );
  return Number(rows.rows[0]!.n);
}

/* --------------------------------- suite --------------------------------- */

describe("answer flags (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const a = await seedTenant(client, "flags_a");
    tenantA = { orgId: a.orgId, propertyId: a.propertyId };
    conversationId = a.conversationId;

    const b = await seedTenant(client, "flags_b");
    tenantB = { orgId: b.orgId, propertyId: b.propertyId };
    foreignConversationId = b.conversationId;

    for (const member of [OWNER, DESK, DESK2, OBSERVER]) await provision(member, tenantA.propertyId);
    await provision(OWNER_B, tenantB.propertyId);

    const answer = await seedAnswer(tenantA, conversationId);
    aiRunId = answer.aiRunId;
    messageId = answer.messageId;
    foreignAiRunId = (await seedAnswer(tenantB, foreignConversationId)).aiRunId;
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  describe("AC-1 — one click, attributable to the run", () => {
    it("writes the run, the person, the time and the note", async () => {
      const response = await flag(aiRunId, DESK.token, { note: "Cierra a las 21:00, no a las 07:00." });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ created: true });
      expect(typeof response.body["flagId"]).toBe("string");

      const rows = await flagsFor(aiRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ai_run_id: aiRunId,
        flagged_by: DESK.userUuid,
        note: "Cierra a las 21:00, no a las 07:00.",
      });
      const stored = await client.query<{ created_at: Date }>(
        "SELECT created_at FROM answer_flags WHERE flag_id = $1",
        [response.body["flagId"]],
      );
      expect(stored.rows[0]!.created_at.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("needs no note — one click means one click", async () => {
      const second = await seedAnswer(tenantA, conversationId);
      const response = await flag(second.aiRunId, DESK.token);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ created: true });
      const rows = await flagsFor(second.aiRunId);
      expect(rows[0]!.note).toBeNull();
    });

    it("emits answer_flagged_wrong and audits the claim", async () => {
      expect(await eventCount(aiRunId)).toBe(1);
      const event = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM events
          WHERE event_type = 'answer_flagged_wrong' AND payload->>'ai_run_id' = $1`,
        [aiRunId],
      );
      expect(event.rows[0]!.payload).toMatchObject({
        ai_run_id: aiRunId,
        actor_user_id: DESK.userUuid,
        decision: "answer",
      });

      const audit = await client.query<{ action: string; entity_type: string; actor_user_id: string }>(
        `SELECT action, entity_type, actor_user_id FROM audit_log
          WHERE entity_type = 'ai_run' AND entity_id = $1 ORDER BY audit_id`,
        [aiRunId],
      );
      expect(audit.rows).toEqual([
        { action: "answer.flagged", entity_type: "ai_run", actor_user_id: DESK.userUuid },
      ]);
    });

    it("is a retry, not a second opinion, when the same person clicks again", async () => {
      const before = await flagsFor(aiRunId);
      const eventsBefore = await eventCount(aiRunId);

      const replay = await flag(aiRunId, DESK.token, { note: "something new" });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ created: false, flagId: null });

      // One row, one event, and the note from the first click stands: the schema
      // grants no UPDATE, so a retry cannot quietly rewrite what was said.
      expect(await flagsFor(aiRunId)).toHaveLength(before.length);
      expect((await flagsFor(aiRunId))[0]!.note).toBe(before[0]!.note);
      expect(await eventCount(aiRunId)).toBe(eventsBefore);
      const audit = await client.query(
        "SELECT 1 FROM audit_log WHERE entity_type = 'ai_run' AND entity_id = $1",
        [aiRunId],
      );
      expect(audit.rowCount).toBe(1);
    });

    it("counts two colleagues as two flags, because they are two people", async () => {
      const second = await flag(aiRunId, OWNER.token);
      expect(second.body).toMatchObject({ created: true });
      const rows = await flagsFor(aiRunId);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.flagged_by)).size).toBe(2);
      expect(await eventCount(aiRunId)).toBe(2);
    });
  });

  describe("AC-2 — visible on the conversation detail", () => {
    it("shows the flags on the answer that was flagged, and on no other", async () => {
      const page = await detail(DESK.token);
      expect(page.status).toBe(200);
      const messages = page.body["messages"] as Array<{
        messageId: string;
        aiRun: { aiRunId: string; flags: Array<{ flaggedBy: string; mine: boolean; note: string | null }> } | null;
      }>;
      const flaggedMessage = messages.find((m) => m.messageId === messageId);
      expect(flaggedMessage?.aiRun?.flags).toHaveLength(2);
      // `mine` is relative to the reader, which is what lets the screen stop
      // offering the button to the person who already pressed it.
      expect(flaggedMessage?.aiRun?.flags.map((f) => f.mine)).toContain(true);
      expect(flaggedMessage?.aiRun?.flags.some((f) => f.note !== null)).toBe(true);
    });

    it("says `mine` for the colleague who did not file it", async () => {
      const page = await detail(DESK2.token);
      const messages = page.body["messages"] as Array<{
        messageId: string;
        aiRun: { flags: Array<{ mine: boolean }> } | null;
      }>;
      const flaggedMessage = messages.find((m) => m.messageId === messageId);
      expect(flaggedMessage?.aiRun?.flags).toHaveLength(2);
      expect(flaggedMessage?.aiRun?.flags.every((f) => f.mine === false)).toBe(true);
    });

    it("carries no names, because a colleague's display_name is not readable here", async () => {
      // 0004's users.staff_select authorises your own row only. The wire type
      // carries the UUID and `mine`, and nothing that would require widening it.
      const page = await detail(DESK.token);
      const messages = page.body["messages"] as Array<{
        messageId: string;
        aiRun: { flags: Array<Record<string, unknown>> } | null;
      }>;
      const flags = messages.find((m) => m.messageId === messageId)!.aiRun!.flags;
      for (const entry of flags) {
        expect(Object.keys(entry).sort()).toEqual(["createdAt", "flagId", "flaggedBy", "mine", "note"]);
      }
    });
  });

  describe("who may file one", () => {
    it("is 401 without a token", async () => {
      const anonymous = await call({ url: `/api/inbox/answers/${aiRunId}/flag`, body: {} });
      expect(anonymous.status).toBe(401);
    });

    it("is 403 for the read-only observer", async () => {
      const denied = await flag(aiRunId, OBSERVER.token);
      expect(denied.status).toBe(403);
      expect(denied.body["error"]).toBe("role_not_on_surface");
    });

    it("is 400 for a note that overruns the column's CHECK", async () => {
      // Refused by the service with the same limit, so the caller gets a 400 that
      // names the problem rather than a constraint violation from the database.
      const tooLong = await flag(aiRunId, DESK2.token, { note: LONG_NOTE });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body["error"]).toBe("invalid_request");
    });

    it("is 400 for a note that is only whitespace", async () => {
      const blank = await flag(aiRunId, DESK2.token, { note: "   " });
      expect(blank.status).toBe(400);
    });
  });

  describe("tenancy — the composite FK is the backstop", () => {
    it("answers 404 for another tenant's run, never 403", async () => {
      const denied = await flag(foreignAiRunId, OWNER.token);
      expect(denied.status).toBe(404);
      expect(denied.body["error"]).toBe("not_found");
      // Nothing was written anywhere: not in tenant A, not in tenant B.
      expect(await flagsFor(foreignAiRunId)).toHaveLength(0);
      const anywhere = await client.query("SELECT 1 FROM answer_flags");
      for (const row of anywhere.rows) {
        expect(String((row as { ai_run_id: string }).ai_run_id)).not.toBe(foreignAiRunId);
      }
    });

    it("answers 404 for a run that does not exist", async () => {
      const missing = await flag("00000000-0000-4000-8000-000000000009", OWNER.token);
      expect(missing.status).toBe(404);
    });

    it("refuses the foreign reference even with the application layer bypassed", async () => {
      // The point of the composite FK: a raw INSERT naming tenant B's run under
      // tenant A's context cannot succeed, no matter what the GUCs say. A bare
      // ai_run_id FK would have allowed this and left an orphaned flag.
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE concierge_app");
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenantA.orgId]);
        await client.query("SELECT set_config('app.current_property_id', $1, true)", [
          tenantA.propertyId,
        ]);
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [OWNER.userUuid]);
        const attempt = await client
          .query(
            `INSERT INTO answer_flags (org_id, property_id, ai_run_id, flagged_by)
             VALUES ($1, $2, $3, $4)`,
            [tenantA.orgId, tenantA.propertyId, foreignAiRunId, OWNER.userUuid],
          )
          .then(
            () => null,
            (error: unknown) => (error as { code?: string }).code ?? "unknown",
          );
        await client.query("ROLLBACK");
        expect(attempt).not.toBeNull();
        // 23503 (the FK cannot resolve the triple) or 42501 (RLS refused it).
        // Which layer catches it is the database's business; the row is refused.
        expect(["23503", "42501"]).toContain(attempt);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  });

  describe("append-only, enforced by privilege", () => {
    it("will not let the application role rewrite or withdraw a flag", async () => {
      // 0026 grants concierge_app SELECT and INSERT only. A disputed flag that can
      // be quietly withdrawn is a count nobody can trust, so this is asserted
      // rather than assumed: if somebody widens the grant, this test is what
      // notices.
      for (const statement of [
        "UPDATE answer_flags SET note = 'withdrawn' WHERE ai_run_id = $1",
        "DELETE FROM answer_flags WHERE ai_run_id = $1",
      ]) {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL ROLE concierge_app");
          await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenantA.orgId]);
          await client.query("SELECT set_config('app.current_property_id', $1, true)", [
            tenantA.propertyId,
          ]);
          await client.query("SELECT set_config('app.current_user_id', $1, true)", [OWNER.userUuid]);
          const code = await client.query(statement, [aiRunId]).then(
            () => null,
            (error: unknown) => (error as { code?: string }).code ?? "unknown",
          );
          await client.query("ROLLBACK");
          expect(code, statement).toBe("42501");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }

      const rows = await flagsFor(aiRunId);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.note).toBe("Cierra a las 21:00, no a las 07:00.");
    });
  });
});
