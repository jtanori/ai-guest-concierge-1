/**
 * S07-03 — a request exists before the guest is told it does.
 *
 * AC-1 is a statement about a transaction, so the interesting cases are the ones
 * where the transaction does not finish:
 *
 *  - the request and the acknowledgement are written together, in that order;
 *  - if anything after the request fails, **neither** row survives — no orphan
 *    request waiting in a queue for a guest who was never told;
 *  - a foreign conversation id is refused by RLS rather than captured into a
 *    stranger's tenant;
 *  - a second unanswered question reuses the open request and does not queue the
 *    same gap twice.
 *
 * Plus the 0018 trigger: a request may not claim to have been acknowledged or
 * resolved before its status says so.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { t } from "../../src/i18n/catalog.ts";
import { captureRequest, REQUEST_TOPICS } from "../../src/requests/capture.ts";
import { postGuestMessage, type GuestDeps } from "../../src/guest/service.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const SECRET = "r".repeat(40);
const SLUG = "capture-hotel";

let client: pg.Client;
let tenant: TenantContext;
let propertyId: string;
let otherTenant: TenantContext;

function ai(output: unknown) {
  return withResilience(
    createFixedProvider(output, "stub-primary-2026-01-01"),
    createFixedProvider(output, "stub-fallback-2026-01-01"),
    { retries: 0, sleep: async () => {}, now: () => 0 },
  );
}

function deps(output: unknown = {}): GuestDeps {
  return { ai: ai(output), cookieSecret: SECRET, now: () => new Date("2026-10-25T17:00:00Z") };
}

function asApp<T>(fn: (tx: pg.Client) => Promise<T>): Promise<T> {
  return withTenant(client, tenant, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

async function newConversation(target: TenantContext = tenant): Promise<string> {
  const channel = await client.query<{ channel_connection_id: string }>(
    "SELECT channel_connection_id FROM channel_connections WHERE org_id = $1 AND property_id = $2 AND channel = 'web' LIMIT 1",
    [target.orgId, target.propertyId],
  );
  const created = await client.query<{ conversation_id: string }>(
    "INSERT INTO conversations (org_id, property_id, connection_id) VALUES ($1, $2, $3) RETURNING conversation_id",
    [target.orgId, target.propertyId, channel.rows[0]!.channel_connection_id],
  );
  return created.rows[0]!.conversation_id;
}

async function rowsFor(conversationId: string) {
  const requests = await client.query<{ request_id: string; topic: string; status: string }>(
    "SELECT request_id, topic, status FROM service_requests WHERE conversation_id = $1",
    [conversationId],
  );
  const gaps = await client.query<{ gap_id: string; question: string; status: string }>(
    "SELECT gap_id, question, status FROM knowledge_gaps WHERE conversation_id = $1",
    [conversationId],
  );
  const events = await client.query<{ event_type: string }>(
    "SELECT event_type FROM events WHERE conversation_id = $1 ORDER BY event_id",
    [conversationId],
  );
  return {
    requests: requests.rows,
    gaps: gaps.rows,
    events: events.rows.map((row) => row.event_type),
  };
}

describe("request capture (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    const seeded = await seedTenant(client, "capture");
    tenant = { orgId: seeded.orgId, propertyId: seeded.propertyId };
    propertyId = seeded.propertyId;

    // The public surface resolves a tenant by slug, so the guest-turn cases
    // need one.
    await client.query("UPDATE properties SET slug = $2 WHERE property_id = $1", [propertyId, SLUG]);

    const other = await seedTenant(client, "capture-other");
    otherTenant = { orgId: other.orgId, propertyId: other.propertyId };
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("writes the request and the gap in one transaction, with their events (AC-1)", async () => {
    const conversationId = await newConversation();
    const captured = await asApp((tx) =>
      captureRequest(tx, tenant, {
        conversationId,
        topic: "unanswered_question",
        question: "¿Tienen toallas extra en la habitación?",
        language: "es",
        knowledgeGap: true,
        reasonCode: "low_retrieval",
      }),
    );
    expect(captured.created).toBe(true);
    expect(captured.gapCreated).toBe(true);

    const found = await rowsFor(conversationId);
    expect(found.requests).toEqual([
      { request_id: captured.requestId, topic: "unanswered_question", status: "new" },
    ]);
    expect(found.gaps).toEqual([
      { gap_id: captured.gapId, question: "¿Tienen toallas extra en la habitación?", status: "open" },
    ]);
    expect(found.events.filter((type) => type === "request_created")).toHaveLength(1);
    expect(found.events.filter((type) => type === "knowledge_gap_created")).toHaveLength(1);
  });

  it("reuses the open request and does not queue the same gap twice", async () => {
    const conversationId = await newConversation();
    const first = await asApp((tx) =>
      captureRequest(tx, tenant, {
        conversationId,
        topic: "unanswered_question",
        question: "¿Hay servicio de lavandería?",
        language: "es",
        knowledgeGap: true,
      }),
    );
    const second = await asApp((tx) =>
      captureRequest(tx, tenant, {
        conversationId,
        topic: "unanswered_question",
        question: "¿Hay servicio de lavandería?",
        language: "es",
        knowledgeGap: true,
      }),
    );
    expect(second.created).toBe(false);
    expect(second.requestId).toBe(first.requestId);
    expect(second.gapId).toBe(first.gapId);
    expect(second.gapCreated).toBe(false);

    const found = await rowsFor(conversationId);
    expect(found.requests).toHaveLength(1);
    expect(found.gaps).toHaveLength(1);
    // One event per real creation — a retry must not double the queue's counts.
    expect(found.events.filter((type) => type === "request_created")).toHaveLength(1);
  });

  it("adds a second gap when the guest asks a different unanswered question", async () => {
    const conversationId = await newConversation();
    await asApp((tx) =>
      captureRequest(tx, tenant, { conversationId, topic: "unanswered_question", question: "uno", knowledgeGap: true }),
    );
    const second = await asApp((tx) =>
      captureRequest(tx, tenant, { conversationId, topic: "unanswered_question", question: "dos", knowledgeGap: true }),
    );
    expect(second.created).toBe(false);
    expect(second.gapCreated).toBe(true);
    const found = await rowsFor(conversationId);
    expect(found.requests).toHaveLength(1);
    expect(found.gaps).toHaveLength(2);
  });

  it("leaves no orphan request when the transaction rolls back", async () => {
    const conversationId = await newConversation();
    await expect(
      asApp(async (tx) => {
        await captureRequest(tx, tenant, {
          conversationId,
          topic: "needs_human",
          question: "Quiero un reembolso",
          language: "es",
        });
        // Anything that fails after the capture — an event insert, a message,
        // a policy check — must take the request with it.
        throw new Error("downstream failure");
      }),
    ).rejects.toThrow("downstream failure");

    const found = await rowsFor(conversationId);
    expect(found.requests).toEqual([]);
    expect(found.events).toEqual([]);
  });

  it("refuses a conversation from another tenant (two layers, no check we wrote)", async () => {
    const foreignConversation = await newConversation(otherTenant);
    const error = await asApp((tx) =>
      captureRequest(tx, tenant, {
        conversationId: foreignConversation,
        topic: "needs_human",
        question: "ajena",
      }),
    ).then(
      () => null,
      (thrown: unknown) => thrown as { code?: string },
    );
    expect(error).not.toBeNull();
    // 23503 (foreign key): the composite (org_id, property_id, conversation_id)
    // reference cannot resolve, because this tenant's conversation set does not
    // contain that id. 42501 (RLS) is the other shape the same mistake can take.
    // Either way the row is refused and nothing is written — which is the claim
    // the test makes; which layer catches it is the database's business.
    expect(["23503", "42501"]).toContain(error?.code);

    const found = await rowsFor(foreignConversation);
    expect(found.requests).toEqual([]);
  });

  it("refuses a status that claims to be further along than it is (0018)", async () => {
    const conversationId = await newConversation();
    // Acknowledged while still `new`.
    await expect(
      client.query(
        `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status, acknowledged_at)
         VALUES ($1, $2, $3, 'needs_human', 'new', now())`,
        [tenant.orgId, tenant.propertyId, conversationId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });

    // Resolved timestamp on a row that is not resolved.
    await expect(
      client.query(
        `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status, resolved_at)
         VALUES ($1, $2, $3, 'needs_human', 'acknowledged', now())`,
        [tenant.orgId, tenant.propertyId, conversationId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });

    // The honest pair is accepted.
    await expect(
      client.query(
        `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status, acknowledged_at)
         VALUES ($1, $2, $3, 'needs_human', 'acknowledged', now())`,
        [tenant.orgId, tenant.propertyId, conversationId],
      ),
    ).resolves.toBeDefined();
  });

  it("captures a request for every guest turn that promises a human (AC-1, end to end)", async () => {
    // A refund question: escalated by the sensitive-topic classifier. The guest
    // is told a person has it, so a person must have it.
    const turn = await postGuestMessage(deps({}), client, {
      slug: SLUG,
      text: "Quiero un reembolso de la noche del sábado",
      language: "es",
    });
    expect(turn.decision).toBe("escalate");
    expect(turn.messages[1]!.body).toContain(t("guest.request_ack", "es"));

    const found = await rowsFor(turn.conversationId);
    expect(found.requests).toEqual([
      expect.objectContaining({ topic: "needs_human", status: "new" }),
    ]);
    expect(found.events).toContain("request_created");

    // A second escalated question joins the same open request: one conversation,
    // one thing for a human to do.
    const again = await postGuestMessage(deps({}), client, {
      slug: SLUG,
      text: "Creo que mi tarjeta se quedó cobrada dos veces",
      language: "es",
    });
    const after = await rowsFor(again.conversationId);
    expect(after.requests).toHaveLength(1);
  });

  it("captures a gap-backed request on a no-answer, without duplicating the gap (AC-1)", async () => {
    const turn = await postGuestMessage(deps({}), client, {
      slug: SLUG,
      text: "xyzzyqqq",
      language: "es",
    });
    expect(turn.decision).toBe("no_answer");
    expect(turn.messages[1]!.body).toContain(t("guest.idontknow", "es"));

    const found = await rowsFor(turn.conversationId);
    expect(found.requests).toEqual([
      expect.objectContaining({ topic: "unanswered_question", status: "new" }),
    ]);
    // The pipeline (S05-02) wrote this gap; capture found it instead of adding a
    // second row for the same missed question.
    expect(found.gaps).toEqual([
      expect.objectContaining({ question: "xyzzyqqq", status: "open" }),
    ]);
  });

  it("declares a topic for every kind of request it can create", () => {
    expect(REQUEST_TOPICS).toContain("guest_requested_human");
    expect(REQUEST_TOPICS).toContain("unanswered_question");
    expect(REQUEST_TOPICS).toContain("needs_human");
    expect(REQUEST_TOPICS).toContain("ai_unavailable");
  });
});
