/**
 * S08-04 — "mode change applies to the next message, no deploy".
 *
 * The AC is about *absence*: no cache, no restart, no deploy. A test that only
 * checked the four modes would pass against an implementation that read the mode
 * once per process, so every case here flips the mode through the real HTTP route
 * and then sends the very next message **in the same process, on the same
 * connection pool, with no reload in between**.
 *
 * The counting provider is the other half of the assertion: in `human_only` and
 * `draft` the model must not be called at all, and "was not called" is a number
 * this test can see (a decision string alone would also be produced by a provider
 * that was called and refused).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import { verifyWithJwk, type StaffIdentity } from "../../src/auth/session.ts";
import { answerMessage } from "../../src/ai/answer.ts";
import type { ResilientAi } from "../../src/ai/provider.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { DEFAULT_SETTINGS, type BusinessDay } from "../../src/settings/schema.ts";
import { handleSettingsRequest, type ReviewHttpDeps } from "../../src/staff/http.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const KEY = ecKey("modes-key");
const BODY = "La alberca abre de 07:00 a 21:00 todos los días.";
const QUOTE = "de 07:00 a 21:00";
const ANSWER = "La alberca abre de 07:00 a 21:00.";

interface Person {
  email: string;
  neon: string;
  roleId: number;
  userUuid: string;
  token: string;
}

function person(key: string, roleId: number): Person {
  const email = `${key}@modes.mx`;
  return {
    email,
    neon: `auth|modes-${key}`,
    roleId,
    userUuid: "",
    token: mint(KEY, liveClaims({ sub: `auth|modes-${key}`, email, name: key })),
  };
}

// role_id 1 owner, 2 manager, 3 front_desk, 4 observer (0001)
const MANAGER = person("manager", 2);
const OBSERVER = person("observer", 4);

let client: pg.Client;
let tenant: TenantContext;
let other: TenantContext;
let conversationId = "";
let versionId = "";

/** A provider that counts its calls, so "the model was not consulted" is visible. */
function countingAi(): { ai: ResilientAi; calls: () => number } {
  let calls = 0;
  return {
    ai: {
      isCircuitOpen: () => false,
      generate: async () => {
        calls += 1;
        return {
          modelId: "counted-model-2026-01-01",
          raw: {
            decision: "answer",
            answer: ANSWER,
            language: "es-MX",
            citations: [{ article_version_id: versionId, quote: QUOTE }],
            reason_code: null,
            topic_keys_used: ["pool.hours"],
            confidence: 0.91,
          },
          usedFallback: false,
          attempts: 1,
          latencyMs: 4,
        };
      },
    },
    calls: () => calls,
  };
}

function identityFor(token: string): StaffIdentity {
  return verifyWithJwk(token, KEY.jwk as never, TEST_VERIFY);
}

async function call(options: {
  method?: string;
  url: string;
  token?: string;
  context?: TenantContext;
  body?: unknown;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { host: "modes.test" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.context !== undefined) {
    headers["x-org-id"] = options.context.orgId;
    headers["x-property-id"] = options.context.propertyId;
  }
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  const req = {
    method: options.method ?? "GET",
    url: options.url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload !== "") yield Buffer.from(payload);
    },
  } as unknown as IncomingMessage;

  const captured = { status: 0, body: {} as Record<string, unknown> };
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
  await handleSettingsRequest(req, res, deps);
  return captured;
}

function setMode(mode: string, token = MANAGER.token) {
  return call({
    method: "POST",
    url: "/api/settings/ai-mode",
    token,
    context: tenant,
    body: { mode },
  });
}

/** The very next message, in the same process, with no reload in between. */
function nextMessage(at: Date, ai: ResilientAi) {
  return withTenant(client, tenant, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return answerMessage(
      tx,
      tenant,
      {
        conversationId,
        messageId: null,
        text: "¿A qué hora abre la alberca?",
        language: "es",
        channel: "web",
        at,
      },
      { ai },
    );
  });
}

const OPEN_ALL_DAYS: BusinessDay[] = Array.from({ length: 7 }, (_unused, day) => ({
  day,
  closed: false,
  open: "08:00",
  close: "22:00",
}));

async function asApp<T>(context: TenantContext, fn: (tx: pg.Client) => Promise<T>): Promise<T> {
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
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

describe("AI operating modes (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const fixture = await seedTenant(client, "modes");
    tenant = { orgId: fixture.orgId, propertyId: fixture.propertyId };
    conversationId = fixture.conversationId;

    const otherFixture = await seedTenant(client, "modes_other");
    other = { orgId: otherFixture.orgId, propertyId: otherFixture.propertyId };

    await client.query(
      `UPDATE properties
          SET settings = $1::jsonb, time_zone = 'America/Mexico_City', ai_mode = 'auto'
        WHERE property_id = $2`,
      [
        JSON.stringify({
          ...DEFAULT_SETTINGS,
          enabled_topics: ["pool.hours"],
          business_hours: OPEN_ALL_DAYS,
        }),
        tenant.propertyId,
      ],
    );

    const version = await asApp(tenant, async (tx) => {
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'pool.hours', 'Alberca', 'es') RETURNING article_id`,
        [tenant.orgId, tenant.propertyId],
      );
      const created = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, $4, $5::vector) RETURNING article_version_id`,
        [
          tenant.orgId,
          tenant.propertyId,
          article.rows[0]!.article_id,
          BODY,
          toVectorLiteral(stubEmbedding(BODY)),
        ],
      );
      const id = created.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [id]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [tenant.orgId, tenant.propertyId, id, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
      return id;
    });
    versionId = version;

    await provision(MANAGER, tenant.propertyId);
    await provision(OBSERVER, tenant.propertyId);
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("auto is the default and the model answers", async () => {
    const current = await call({ url: "/api/settings/ai-mode", token: MANAGER.token, context: tenant });
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ aiMode: "auto", timeZone: "America/Mexico_City" });

    const provider = countingAi();
    const outcome = await nextMessage(new Date("2026-10-26T15:00:00Z"), provider.ai);
    expect(outcome.kind).toBe("answer");
    expect(provider.calls()).toBe(1);
  });

  it("human_only takes effect on the very next message, with no restart (AC-2)", async () => {
    const flipped = await setMode("human_only");
    expect(flipped.status).toBe(200);
    expect(flipped.body).toMatchObject({ aiMode: "human_only", changed: true, previous: "auto" });

    const provider = countingAi();
    const outcome = await nextMessage(new Date("2026-10-26T15:01:00Z"), provider.ai);

    expect(outcome.kind).toBe("escalate");
    expect(outcome.kind === "escalate" ? outcome.detail : null).toBe("mode_human_only");
    // The point of the mode: the model is not consulted, so it costs nothing.
    expect(provider.calls()).toBe(0);

    const audit = await client.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log
        WHERE property_id = $1 AND action = 'settings.updated'
        ORDER BY audit_id DESC LIMIT 1`,
      [tenant.propertyId],
    );
    expect(audit.rows[0]!.detail).toMatchObject({ changed: ["ai_mode"], previous: "auto", ai_mode: "human_only" });
  });

  it("draft escalates the next message too", async () => {
    expect((await setMode("draft")).status).toBe(200);
    const provider = countingAi();
    const outcome = await nextMessage(new Date("2026-10-26T15:02:00Z"), provider.ai);
    expect(outcome.kind).toBe("escalate");
    expect(outcome.kind === "escalate" ? outcome.detail : null).toBe("mode_draft");
    expect(provider.calls()).toBe(0);
  });

  it("after_hours reads the property's time zone, not UTC (AC-2)", async () => {
    expect((await setMode("after_hours")).status).toBe(200);

    // 15:00Z is 09:00 in Mexico City: inside 08:00-22:00, so the model answers.
    const open = countingAi();
    const inside = await nextMessage(new Date("2026-10-26T15:00:00Z"), open.ai);
    expect(inside.kind).toBe("answer");
    expect(open.calls()).toBe(1);

    // 04:00Z is 22:00 the previous local day: closed, so it escalates.
    const closed = countingAi();
    const outside = await nextMessage(new Date("2026-10-26T04:00:00Z"), closed.ai);
    expect(outside.kind).toBe("escalate");
    expect(outside.kind === "escalate" ? outside.detail : null).toBe("after_hours");
    expect(closed.calls()).toBe(0);
  });

  it("does not touch another property's mode (tenancy)", async () => {
    // `tenant` is in human_only/after_hours; `other` was never flipped.
    await setMode("human_only");
    const otherMode = await client.query<{ ai_mode: string }>(
      "SELECT ai_mode FROM properties WHERE property_id = $1",
      [other.propertyId],
    );
    expect(otherMode.rows[0]!.ai_mode).toBe("auto");

    const theirs = await call({
      url: "/api/settings/ai-mode",
      token: MANAGER.token,
      context: other,
    });
    // MANAGER is not a member of the other property, so even reading is refused.
    expect(theirs.status).toBe(403);
  });

  it("refuses a non-member, an observer, and an unknown mode", async () => {
    const observer = await setMode("auto", OBSERVER.token);
    expect(observer.status).toBe(403);
    expect(observer.body["error"]).toBe("role_not_on_surface");

    const bogus = await setMode("yolo");
    expect(bogus.status).toBe(400);
    expect(bogus.body["error"]).toBe("invalid_request");

    const anonymous = await call({ method: "POST", url: "/api/settings/ai-mode", context: tenant });
    expect(anonymous.status).toBe(401);
  });

  it("does not audit a no-op write", async () => {
    expect((await setMode("auto")).status).toBe(200);
    const before = await client.query<{ count: string }>(
      "SELECT count(*) FROM audit_log WHERE property_id = $1 AND action = 'settings.updated'",
      [tenant.propertyId],
    );
    const again = await setMode("auto");
    expect(again.body).toMatchObject({ aiMode: "auto", changed: false, previous: "auto" });
    const after = await client.query<{ count: string }>(
      "SELECT count(*) FROM audit_log WHERE property_id = $1 AND action = 'settings.updated'",
      [tenant.propertyId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });
});
