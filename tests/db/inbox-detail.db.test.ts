/**
 * S08-02 — "staff can see the cited text verbatim", against a real database.
 *
 * Two ACs, and they are different kinds of claim:
 *
 * - **AC-1** is coverage: a detail request returns each AI message with its
 *   citations, the quote the model used, and the cited version's body.
 * - **AC-2** is durability: the article is edited twice after the answer, and
 *   the pane shows the same text it showed the day the guest asked.
 *
 * The second one is why this file goes through the real HTTP handler and the
 * real `answerMessage` rather than inserting citation rows by hand. A test that
 * fabricates `citations` cannot catch the bug this item exists to prevent: the
 * write path quietly dropping the quote again. So the quote here travels the
 * whole way — provider output → guard → `recordCitations` → 0022 → `SELECT` →
 * JSON — and the assertion is a string the stub provider typed.
 *
 * The XSS case is included for the same reason: the API returns raw text and the
 * React page relies on JSX escaping, so the guarantee that has to hold *here* is
 * "the payload is unchanged and not pre-escaped". If this ever starts returning
 * `&lt;script&gt;`, some layer is escaping twice and the transcript is lying.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import { verifyWithJwk, type StaffIdentity } from "../../src/auth/session.ts";
import { answerMessage } from "../../src/ai/answer.ts";
import { reconstructAnswer } from "../../src/ai/history.ts";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { handleInboxRequest, type ReviewHttpDeps } from "../../src/staff/http.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const KEY = ecKey("detail-key");

const V1_BODY =
  "La alberca está abierta de 07:00 a 20:00 todos los días. El último acceso es a las 19:45 y hay toallas en el módulo de alberca.";
const V2_BODY =
  "La alberca está abierta de 07:00 a 21:00 en temporada alta. El último acceso es a las 20:45.";
const QUOTE = "de 07:00 a 20:00 todos los días";
/** A guest message that would be script if any layer ever stopped escaping. */
const HOSTILE = `<script>alert("xss")</script> ¿A qué hora cierra la alberca?`;

interface Person {
  email: string;
  neon: string;
  roleId: number;
  token: string;
}

function person(key: string, roleId: number): Person {
  const email = `${key}@detail.mx`;
  return {
    email,
    neon: `auth|detail-${key}`,
    roleId,
    token: mint(KEY, liveClaims({ sub: `auth|detail-${key}`, email, name: key })),
  };
}

// role_id 1 owner, 2 manager, 3 front_desk, 4 observer (0001)
const DESK = person("desk", 3);
const OBSERVER = person("observer", 4);
const OWNER_B = person("owner_b", 1);

let client: pg.Client;
let tenant: TenantContext;
let conversationId = "";
let foreignConversationId = "";
let articleId = "";
let guestMessageId = "";
let aiMessageId = "";
let aiRunId = "";

function identityFor(token: string): StaffIdentity {
  return verifyWithJwk(token, KEY.jwk as never, TEST_VERIFY);
}

function fakeReq(options: {
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
}): IncomingMessage {
  const headers: Record<string, string> = { host: "detail.test" };
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

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

async function call(options: {
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
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
  const deps: ReviewHttpDeps = {
    client,
    verifyToken: async (token: string) => identityFor(token),
  };
  await handleInboxRequest(fakeReq(options), res, deps);
  return captured;
}

function stubAi(citation: string) {
  const output = {
    decision: "answer",
    answer: "La alberca cierra a las 20:00.",
    language: "es-MX",
    citations: [{ article_version_id: citation, quote: QUOTE }],
    reason_code: null,
    topic_keys_used: ["pool.hours"],
    confidence: 0.92,
  };
  return withResilience(
    createFixedProvider(output, "stub-model-2026-01-01"),
    createFixedProvider(output, "stub-fb-2026-01-01"),
    { retries: 0, sleep: async () => {}, now: () => 0 },
  );
}

function asApp<T>(context: TenantContext, fn: (tx: pg.Client) => Promise<T>): Promise<T> {
  return withTenant(client, context, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

interface MessageShape {
  messageId: string;
  authorRole: string;
  body: string;
  aiRun: {
    aiRunId: string;
    decision: string;
    modelId: string;
    promptVersion: string;
    citations: Array<{
      articleVersionId: string;
      quote: string | null;
      body: string;
      versionNo: number;
      isCurrent: boolean;
      title: string;
    }>;
  } | null;
}

function messages(body: Record<string, unknown>): MessageShape[] {
  return body["messages"] as MessageShape[];
}

async function publishVersion(versionNo: number, body: string): Promise<string> {
  return asApp(tenant, async (tx) => {
    const created = await tx.query<{ article_version_id: string }>(
      `INSERT INTO article_versions
         (org_id, property_id, article_id, version_no, is_current, body, embedding)
       VALUES ($1, $2, $3, $4, false, $5, $6::vector) RETURNING article_version_id`,
      [tenant.orgId, tenant.propertyId, articleId, versionNo, body, toVectorLiteral(stubEmbedding(body))],
    );
    const id = created.rows[0]!.article_version_id;
    await tx.query("SELECT promote_article_version($1)", [id]);
    return id;
  });
}

async function provision(context: TenantContext, member: Person, roleId: number): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");
    const user = await client.query<{ user_id: string }>(
      "SELECT provision_user($1, $2, $3) AS user_id",
      [member.neon, member.email, member.email],
    );
    await client.query("COMMIT");
    await client.query(
      "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, $3)",
      [user.rows[0]!.user_id, context.propertyId, roleId],
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describe("conversation detail (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    const fixture = await seedTenant(client, "detail");
    tenant = { orgId: fixture.orgId, propertyId: fixture.propertyId };
    conversationId = fixture.conversationId;

    const other = await seedTenant(client, "detail_other");
    foreignConversationId = other.conversationId;

    await client.query("UPDATE properties SET settings = $1::jsonb WHERE property_id = $2", [
      JSON.stringify({ ...DEFAULT_SETTINGS, enabled_topics: ["pool.hours"] }),
      tenant.propertyId,
    ]);
    // A front desk reads hotel-local times; the response carries the zone so the
    // page never formats in the server's zone (UTC in CI, and usually wrong).
    await client.query("UPDATE properties SET time_zone = 'America/Mexico_City' WHERE property_id = $1", [
      tenant.propertyId,
    ]);

    await provision(tenant, DESK, DESK.roleId);
    await provision(tenant, OBSERVER, OBSERVER.roleId);

    const v1 = await asApp(tenant, async (tx) => {
      const article = await tx.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'pool.hours', 'Alberca', 'es') RETURNING article_id`,
        [tenant.orgId, tenant.propertyId],
      );
      articleId = article.rows[0]!.article_id;
      const version = await tx.query<{ article_version_id: string }>(
        `INSERT INTO article_versions
           (org_id, property_id, article_id, version_no, is_current, body, embedding)
         VALUES ($1, $2, $3, 1, false, $4, $5::vector) RETURNING article_version_id`,
        [tenant.orgId, tenant.propertyId, articleId, V1_BODY, toVectorLiteral(stubEmbedding(V1_BODY))],
      );
      const id = version.rows[0]!.article_version_id;
      await tx.query("SELECT promote_article_version($1)", [id]);
      await tx.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [tenant.orgId, tenant.propertyId, id, V1_BODY, toVectorLiteral(stubEmbedding(V1_BODY))],
      );

      // The guest turn and the AI turn, in order. `answerMessage` does not write
      // messages (S07-03 owns that), so the test does what the pipeline does:
      // insert the outbound row first, then hand its id to the model call.
      const guest = await tx.query<{ message_id: string }>(
        `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body, created_at)
         VALUES ($1, $2, $3, 'inbound', 'guest', $4, now() - interval '6 minutes')
         RETURNING message_id`,
        [tenant.orgId, tenant.propertyId, conversationId, HOSTILE],
      );
      guestMessageId = guest.rows[0]!.message_id;
      const ai = await tx.query<{ message_id: string }>(
        `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body, created_at)
         VALUES ($1, $2, $3, 'outbound', 'ai', 'La alberca cierra a las 20:00.', now() - interval '5 minutes')
         RETURNING message_id`,
        [tenant.orgId, tenant.propertyId, conversationId],
      );
      aiMessageId = ai.rows[0]!.message_id;
      return id;
    });

    const outcome = await asApp(tenant, (tx) =>
      answerMessage(
        tx,
        tenant,
        {
          conversationId,
          messageId: aiMessageId,
          text: HOSTILE,
          language: "es",
          channel: "web",
        },
        { ai: stubAi(v1) },
      ),
    );
    if (outcome.kind !== "answer") throw new Error(`expected an answer, got ${outcome.kind}`);
    aiRunId = outcome.aiRunId;
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("returns the transcript with the AI message's cited quote and body (AC-1)", async () => {
    const page = await call({
      url: `/api/inbox/conversations/${conversationId}`,
      token: DESK.token,
      context: tenant,
    });
    expect(page.status).toBe(200);
    expect(page.body["conversationId"]).toBe(conversationId);
    expect(page.body["timeZone"]).toBe("America/Mexico_City");

    const list = messages(page.body);
    expect(list.map((message) => message.authorRole)).toEqual(["guest", "ai"]);
    const guest = list[0]!;
    const answer = list[1]!;

    // Chronological, and the raw text on the wire: escaping belongs to the
    // renderer, not the service (a pre-escaped transcript is corrupted for every
    // other consumer, and double-escapes on the next hop).
    expect(guest.messageId).toBe(guestMessageId);
    expect(guest.body).toBe(HOSTILE);
    expect(guest.aiRun).toBeNull();

    expect(answer.messageId).toBe(aiMessageId);
    expect(answer.aiRun).not.toBeNull();
    expect(answer.aiRun!.aiRunId).toBe(aiRunId);
    expect(answer.aiRun!.decision).toBe("answer");
    expect(answer.aiRun!.modelId).toBe("stub-model-2026-01-01");
    expect(answer.aiRun!.promptVersion).toBe("answer-v1");

    expect(answer.aiRun!.citations).toHaveLength(1);
    expect(answer.aiRun!.citations[0]).toMatchObject({
      quote: QUOTE,
      body: V1_BODY,
      versionNo: 1,
      isCurrent: true,
      title: "Alberca",
    });
    // The quote must actually be inside the body it claims to come from, or the
    // pane is showing staff a sentence that was never in the source.
    expect(answer.aiRun!.citations[0]!.body).toContain(answer.aiRun!.citations[0]!.quote!);
  });

  it("shows the same text after the article is edited twice (AC-2)", async () => {
    await publishVersion(2, V2_BODY);
    const afterOne = await call({
      url: `/api/inbox/conversations/${conversationId}`,
      token: DESK.token,
      context: tenant,
    });
    const first = messages(afterOne.body)[1]!.aiRun!.citations[0]!;
    expect(first.quote).toBe(QUOTE);
    expect(first.body).toBe(V1_BODY);
    // History is honest about itself: the citation now points at an old version.
    expect(first.isCurrent).toBe(false);
    expect(first.versionNo).toBe(1);

    const v3 = "La alberca cierra a las 22:00 en Nochevieja.";
    await publishVersion(3, v3);
    const afterTwo = await call({
      url: `/api/inbox/conversations/${conversationId}`,
      token: DESK.token,
      context: tenant,
    });
    const second = messages(afterTwo.body)[1]!.aiRun!.citations[0]!;
    expect(second.body).toBe(V1_BODY);
    expect(second.quote).toBe(QUOTE);
    expect(second.body).not.toContain(v3);
  });

  it("keeps the quote on the reconstruction path too, not just the detail pane", async () => {
    // One join serves both (S05-03's `reconstructAnswer` and this view); if they
    // ever diverge, one of them starts lying about what was cited.
    const reconstructed = await asApp(tenant, (tx) => reconstructAnswer(tx, tenant, aiRunId));
    expect(reconstructed.citations[0]!.quote).toBe(QUOTE);
  });

  it("404s another tenant's conversation without revealing that it exists", async () => {
    const foreign = await call({
      url: `/api/inbox/conversations/${foreignConversationId}`,
      token: DESK.token,
      context: tenant,
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body["error"]).toBe("not_found");

    const unknown = await call({
      url: "/api/inbox/conversations/00000000-0000-4000-8000-000000000000",
      token: DESK.token,
      context: tenant,
    });
    expect(unknown.status).toBe(404);
    // Identical body shape: existence is not something this route confirms.
    expect(unknown.body["error"]).toBe(foreign.body["error"]);

    const malformed = await call({
      url: "/api/inbox/conversations/not-a-uuid",
      token: DESK.token,
      context: tenant,
    });
    expect(malformed.status).toBe(404);
  });

  it("refuses a quote that could never have come out of the model (0022 CHECK)", async () => {
    // The column is not a dumping ground: the same 400-character bound the
    // contract enforces in `src/ai/contract.ts` is enforced by the table, so a
    // future writer cannot quietly store a whole article in `quote`.
    const long = "x".repeat(401);
    await expect(
      asApp(tenant, (tx) =>
        tx.query(
          `INSERT INTO citations (org_id, property_id, ai_run_id, article_version_id, quote)
           VALUES ($1, $2, $3, (SELECT article_version_id FROM article_versions
                                 WHERE org_id = $1 ORDER BY version_no LIMIT 1), $4)`,
          [tenant.orgId, tenant.propertyId, aiRunId, long],
        ),
      ),
    ).rejects.toThrow(/citations_quote_shape/);
    await expect(
      asApp(tenant, (tx) =>
        tx.query(
          `INSERT INTO citations (org_id, property_id, ai_run_id, article_version_id, quote)
           VALUES ($1, $2, $3, (SELECT article_version_id FROM article_versions
                                 WHERE org_id = $1 ORDER BY version_no LIMIT 1), '   ')`,
          [tenant.orgId, tenant.propertyId, aiRunId],
        ),
      ),
    ).rejects.toThrow(/citations_quote_shape/);
  });

  it("requires a staff token", async () => {
    const anonymous = await call({ url: `/api/inbox/conversations/${conversationId}` });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body["error"]).toBe("unauthorized");
  });

  it("lets the read-only observer read, because this screen has no actions", async () => {
    // Deviation from the charter's S08-01 precedent is deliberate and recorded in
    // §10: the role matrix grants `queue: read` to all four roles, and this item
    // adds no write. An observer who could not see what the bot told a guest
    // could not do the one job an observer has.
    const page = await call({
      url: `/api/inbox/conversations/${conversationId}`,
      token: OBSERVER.token,
      context: tenant,
    });
    expect(page.status).toBe(200);
  });

  it("rejects a tenant in the header that the token does not belong to", async () => {
    const crossed = await call({
      url: `/api/inbox/conversations/${conversationId}`,
      token: OWNER_B.token,
      context: tenant,
    });
    expect(crossed.status).toBe(403);
  });
});
