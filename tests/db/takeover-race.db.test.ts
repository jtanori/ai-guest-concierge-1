/**
 * S08-03 — "no race where AI replies after a takeover", with two connections.
 *
 * This is the only test in the suite where the *interleaving* is the subject, so
 * it is the only one that needs two real connections and a model call that can be
 * held open.
 *
 * The shape:
 *
 *   A: the guest's turn starts, inserts the inbound message, calls the model…
 *   B: a staff member takes over, and COMMITS while A is still thinking…
 *   A: the model answers; the write re-checks the state under the row lock.
 *
 * AC-2 says A must lose. If the pipeline ever goes back to holding the
 * conversation lock across the model call (S06-02's shape), B blocks — and the
 * assertion that fails is the takeover, which is the failure that matters: a human
 * clicked, the queue said yes, and the bot spoke anyway.
 *
 * The assertions are about what a guest would see: exactly one outbound message
 * for the turn, and it is the catalogue's "a person will reply" line, never the
 * model's answer.
 *
 * The knowledge fixture matters. `answerMessage` short-circuits when retrieval
 * finds nothing (`hits.length === 0` → `no_answer` without a provider call), so a
 * test with no article would never reach the model and would hang on the gate
 * instead of exercising the race.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { t } from "../../src/i18n/catalog.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { postGuestMessage, type GuestDeps } from "../../src/guest/service.ts";
import { takeOverConversation } from "../../src/inbox/actions.ts";
import type { StaffSession } from "../../src/auth/context.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const SECRET = "g".repeat(40);
const DISCLOSURE_ES = t("guest.ai_disclosure", "es");
const PENDING_ES = t("guest.staff_reply_pending", "es");
const firstReply = (body: string): string => `${DISCLOSURE_ES}\n\n${body}`;
const BODY = "La alberca abre a las 07:00 y cierra a las 21:00 todos los días.";
const QUOTE = "cierra a las 21:00";
const MODEL_ANSWER = "La alberca cierra a las 21:00.";

let guestClient: pg.Client;
let staffClient: pg.Client;
let tenant: { orgId: string; propertyId: string };
let conversationId = "";
let userId = "";
let versionId = "";

/** The answer the model gives, citing the seeded version with a real quote. */
function citedAnswer() {
  return {
    decision: "answer",
    answer: MODEL_ANSWER,
    language: "es-MX",
    citations: [{ article_version_id: versionId, quote: QUOTE }],
    reason_code: null,
    topic_keys_used: ["pool.hours"],
    confidence: 0.9,
  };
}

/**
 * A provider that parks inside `generate` until the test releases it.
 *
 * Built by hand rather than from the stub: the whole point is to control exactly
 * when the model returns relative to the takeover's commit.
 */
function gatedAi(): { ai: GuestDeps["ai"]; entered: Promise<void>; release: () => void } {
  let enteredResolve: () => void = () => undefined;
  let releaseResolve: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });

  return {
    ai: {
      isCircuitOpen: () => false,
      generate: async () => {
        enteredResolve();
        await gate;
        return {
          modelId: "gated-primary-2026-01-01",
          raw: citedAnswer(),
          usedFallback: false,
          attempts: 1,
          latencyMs: 5,
        };
      },
    },
    entered,
    release: () => releaseResolve(),
  };
}

function session(): StaffSession {
  return { userUuid: userId, role: "front_desk", requireRole: () => undefined };
}

async function outbound(target = conversationId): Promise<
  { body: string; author_role: string; created_at: Date }[]
> {
  const rows = await staffClient.query<{ body: string; author_role: string; created_at: Date }>(
    `SELECT body, author_role, created_at
       FROM messages
      WHERE org_id = $1 AND property_id = $2 AND conversation_id = $3
        AND direction = 'outbound'
      ORDER BY created_at, message_id`,
    [tenant.orgId, tenant.propertyId, target],
  );
  return rows.rows;
}

describe("takeover race (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    guestClient = await connectScratch();
    staffClient = await connectScratch();

    const fixture = await seedTenant(guestClient, "race");
    tenant = { orgId: fixture.orgId, propertyId: fixture.propertyId };
    conversationId = fixture.conversationId;

    await guestClient.query(
      "UPDATE properties SET settings = $1::jsonb WHERE property_id = $2",
      [JSON.stringify({ ...DEFAULT_SETTINGS, enabled_topics: ["pool.hours"] }), tenant.propertyId],
    );

    // One published article so retrieval has something to hit: without it the
    // pipeline answers `no_answer` and never calls the provider at all.
    await guestClient.query("BEGIN");
    try {
      await guestClient.query("SET LOCAL ROLE concierge_app");
      await guestClient.query("SELECT set_config('app.current_org_id', $1, true)", [tenant.orgId]);
      await guestClient.query("SELECT set_config('app.current_property_id', $1, true)", [
        tenant.propertyId,
      ]);
      const article = await guestClient.query<{ article_id: string }>(
        `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
         VALUES ($1, $2, 'property', 'pool.hours', 'Alberca', 'es') RETURNING article_id`,
        [tenant.orgId, tenant.propertyId],
      );
      const version = await guestClient.query<{ article_version_id: string }>(
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
      versionId = version.rows[0]!.article_version_id;
      await guestClient.query("SELECT promote_article_version($1)", [versionId]);
      await guestClient.query(
        `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [tenant.orgId, tenant.propertyId, versionId, BODY, toVectorLiteral(stubEmbedding(BODY))],
      );
      await guestClient.query("COMMIT");
    } catch (error) {
      await guestClient.query("ROLLBACK");
      throw error;
    }

    await guestClient.query("BEGIN");
    try {
      await guestClient.query("SET LOCAL ROLE concierge_app");
      const user = await guestClient.query<{ user_id: string }>(
        "SELECT provision_user('auth|race-desk', 'desk@race.mx', 'Race Desk') AS user_id",
      );
      userId = user.rows[0]!.user_id;
      await guestClient.query("COMMIT");
    } catch (error) {
      await guestClient.query("ROLLBACK");
      throw error;
    }
    await staffClient.query(
      "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 3)",
      [userId, tenant.propertyId],
    );
  });

  afterAll(async () => {
    await guestClient.end();
    await staffClient.end();
    await dropScratch();
  });

  it("a takeover committed mid-flight makes the model's answer lose (AC-2)", async () => {
    const gated = gatedAi();
    const deps: GuestDeps = {
      ai: gated.ai,
      cookieSecret: SECRET,
      now: () => new Date("2026-10-26T15:00:00Z"),
    };

    const thread = await guestThread("midflight");
    conversationId = thread.conversationId;
    const turn = postGuestMessage(deps, guestClient, {
      slug: "race",
      text: "¿A qué hora cierra la alberca?",
      language: "es",
      ticket: thread.ticket,
      ip: "203.0.113.9",
    });
    turn.catch((error: unknown) => console.error("TURN FAILED:", error));

    // The model is being called right now: this is the window the takeover wins.
    await withTimeout(gated.entered, 5000, "the model was never called");

    // A human claims the thread on a DIFFERENT connection and commits. If the
    // guest turn held the row lock, this would block until the model finished —
    // which is precisely the behaviour AC-2 forbids.
    const takenOver = await withTimeout(
      takeOverConversation(staffClient, tenant, session(), { conversationId }),
      3000,
      "the takeover blocked on the model's lock",
    );
    expect(takenOver).toMatchObject({ aiState: "awaiting_staff", alreadyOwned: false });

    gated.release();
    const result = await turn;

    // The guest was answered — by the catalogue, not by the model.
    expect(result.decision).toBe("handoff");
    expect(result.conversationId).toBe(conversationId);
    const messages = await outbound();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe(firstReply(PENDING_ES));
    expect(messages[0]!.body).not.toContain(MODEL_ANSWER);

    // The thread stays with the human, and the run stays on the record: the model
    // did work and it did cost money, even though nothing reached the guest.
    const state = await staffClient.query<{ ai_state: string }>(
      "SELECT ai_state FROM conversations WHERE conversation_id = $1",
      [conversationId],
    );
    expect(state.rows[0]!.ai_state).toBe("awaiting_staff");
    const runs = await staffClient.query<{ decision: string }>(
      "SELECT decision FROM ai_runs WHERE conversation_id = $1",
      [conversationId],
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]!.decision).toBe("answer");

    // A promise with no queue row behind it is the failure S07-03 exists to
    // prevent, so the lost race still opens a request.
    const requests = await staffClient.query<{ topic: string; status: string }>(
      "SELECT topic, status FROM service_requests WHERE conversation_id = $1",
      [conversationId],
    );
    expect(requests.rows).toHaveLength(1);
    expect(requests.rows[0]!.topic).toBe("needs_human");
  });

  it("the same turn is answered normally when nobody takes over", async () => {
    // The control: the loss above is caused by the takeover, not by the pipeline's
    // new shape breaking every turn.
    const ai = withResilience(
      createFixedProvider(citedAnswer(), "stub-primary-2026-01-01"),
      createFixedProvider({}, "stub-fallback-2026-01-01"),
      { retries: 0, sleep: async () => {}, now: () => 0 },
    );

    const fresh = await guestThread("control");
    const freshId = fresh.conversationId;

    const turn = await postGuestMessage(
      { ai, cookieSecret: SECRET, now: () => new Date("2026-10-26T15:05:00Z") },
      guestClient,
      {
        slug: "race",
        text: "¿A qué hora cierra la alberca?",
        language: "es",
        ticket: fresh.ticket,
        ip: "203.0.113.10",
      },
    );

    expect(turn.decision).toBe("answer");
    const reply = turn.messages[turn.messages.length - 1]!;
    expect(reply.body).toBe(firstReply(MODEL_ANSWER));

    const after = await staffClient.query<{ ai_state: string }>(
      "SELECT ai_state FROM conversations WHERE conversation_id = $1",
      [freshId],
    );
    expect(after.rows[0]!.ai_state).toBe("idle");
    const messages = await outbound(freshId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe(firstReply(MODEL_ANSWER));
  });
});

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/**
 * A guest identity with a conversation of its own, and the ticket that addresses
 * it.
 *
 * `resolveConversation` only honours a ticket whose conversation carries the same
 * `identity_id`, so the race has to run on a conversation this factory created —
 * the seeded one has no identity and a turn would silently get a fresh thread.
 */
async function guestThread(
  name: string,
): Promise<{ conversationId: string; ticket: import("../../src/guest/cookie.ts").GuestTicket }> {
  const { signGuestTicket } = await import("../../src/guest/cookie.ts");
  const connection = await staffClient.query<{ connection_id: string }>(
    "SELECT connection_id FROM conversations WHERE conversation_id = $1",
    [conversationId],
  );
  const identity = await staffClient.query<{ identity_id: string }>(
    `INSERT INTO channel_identities (org_id, property_id, connection_id, external_id)
     VALUES ($1, $2, $3, $4) RETURNING identity_id`,
    [tenant.orgId, tenant.propertyId, connection.rows[0]!.connection_id, `race-${name}`],
  );
  const identityId = identity.rows[0]!.identity_id;
  const created = await staffClient.query<{ conversation_id: string }>(
    `INSERT INTO conversations (org_id, property_id, connection_id, identity_id, language, ai_state)
     VALUES ($1, $2, $3, $4, 'es', 'idle') RETURNING conversation_id`,
    [tenant.orgId, tenant.propertyId, connection.rows[0]!.connection_id, identityId],
  );
  const id = created.rows[0]!.conversation_id;
  // `postGuestMessage` takes the DECODED ticket: the HTTP layer verifies the
  // cookie and hands the payload down, so a test that passes the signed string
  // silently gets a brand-new conversation instead of the threaded one.
  void signGuestTicket;
  return {
    conversationId: id,
    ticket: { identityId, conversationId: id, propertyId: tenant.propertyId },
  };
}
