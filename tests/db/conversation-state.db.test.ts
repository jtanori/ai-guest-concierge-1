/**
 * S06-02 — the transition guard, and what a takeover actually protects.
 *
 * The matrix is walked PAIR BY PAIR through the trigger, for every pair in the
 * product's 4×4 grid: the eight legal edges must succeed and the four illegal
 * ones must raise `P0001`. Both copies of the matrix (SQL and TypeScript) are
 * therefore pinned to each other by execution rather than by a comment.
 *
 * Every state is reached by walking legal transitions from `idle` — no
 * `session_replication_role`, no disabling the trigger, because a test that
 * turns the guard off cannot prove the guard works.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createScriptedProvider } from "../../src/ai/stub.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import {
  AI_STATES,
  IllegalTransitionError,
  StaffTookOverError,
  TRANSITIONS,
  assertModelMaySpeak,
  lockState,
  takeover,
  transition,
  type AiState,
} from "../../src/conversation/state.ts";
import { t } from "../../src/i18n/catalog.ts";
import { signGuestTicket, verifyGuestTicket, type GuestTicket } from "../../src/guest/cookie.ts";
import { postGuestMessage } from "../../src/guest/service.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const SECRET = "s".repeat(40);

let client: pg.Client;
let second: pg.Client;
let tenant: TenantContext;
let channelId: string;

/** A legal path from `idle` to each state, used to set up the pair tests. */
const PATH_TO: Record<AiState, AiState[]> = {
  idle: [],
  awaiting_ai: ["awaiting_ai"],
  awaiting_staff: ["awaiting_staff"],
  resolved: ["awaiting_staff", "resolved"],
};

async function asApp<T>(fn: (tx: pg.Client) => Promise<T>): Promise<T> {
  return withTenant(client, tenant, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    return fn(tx);
  });
}

async function newConversation(): Promise<string> {
  const created = await client.query<{ conversation_id: string }>(
    `INSERT INTO conversations (org_id, property_id, connection_id)
     VALUES ($1, $2, $3) RETURNING conversation_id`,
    [tenant.orgId, tenant.propertyId, channelId],
  );
  return created.rows[0]!.conversation_id;
}

/** Walks legal transitions from `idle`; fails loudly if the path is illegal. */
async function seedState(conversationId: string, target: AiState): Promise<void> {
  for (const step of PATH_TO[target]) {
    await client.query("UPDATE conversations SET ai_state = $2 WHERE conversation_id = $1", [
      conversationId,
      step,
    ]);
  }
}

async function readState(conversationId: string): Promise<string> {
  const row = await client.query<{ ai_state: string }>(
    "SELECT ai_state FROM conversations WHERE conversation_id = $1",
    [conversationId],
  );
  return row.rows[0]!.ai_state;
}

describe("conversation state machine (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    second = await connectScratch();
    const fixture = await seedTenant(client, "state");
    tenant = { orgId: fixture.orgId, propertyId: fixture.propertyId };
    channelId = fixture.channelId;
  });

  afterAll(async () => {
    await second.end();
    await client.end();
    await dropScratch();
  });

  it("starts every conversation idle", async () => {
    const conversationId = await newConversation();
    expect(await readState(conversationId)).toBe("idle");
  });

  it("accepts all eight legal edges through raw SQL", async () => {
    for (const from of AI_STATES) {
      for (const to of TRANSITIONS[from]) {
        const conversationId = await newConversation();
        await seedState(conversationId, from);
        await expect(
          client.query("UPDATE conversations SET ai_state = $2 WHERE conversation_id = $1", [
            conversationId,
            to,
          ]),
        ).resolves.toBeDefined();
        expect(await readState(conversationId)).toBe(to);
      }
    }
  });

  it("rejects every illegal edge at the database level, even in raw SQL", async () => {
    for (const from of AI_STATES) {
      for (const to of AI_STATES) {
        if (to === from || TRANSITIONS[from].includes(to)) continue;
        const conversationId = await newConversation();
        await seedState(conversationId, from);
        await expect(
          client.query("UPDATE conversations SET ai_state = $2 WHERE conversation_id = $1", [
            conversationId,
            to,
          ]),
        ).rejects.toMatchObject({ code: "P0001" });
        // The row is unchanged: a refused transition is not a partial one.
        expect(await readState(conversationId)).toBe(from);
      }
    }
  });

  it("treats a same-state write as a no-op", async () => {
    const conversationId = await newConversation();
    await seedState(conversationId, "resolved");
    await expect(
      client.query("UPDATE conversations SET ai_state = 'resolved' WHERE conversation_id = $1", [
        conversationId,
      ]),
    ).resolves.toBeDefined();
  });

  it("refuses the same illegal edge through the typed service", async () => {
    const conversationId = await newConversation();
    await seedState(conversationId, "awaiting_staff");
    await expect(
      asApp((tx) => transition(tx, tenant, conversationId, "idle")),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it("moves the state, records the handoff reason and emits one takeover event", async () => {
    const conversationId = await newConversation();
    const state = await asApp((tx) =>
      takeover(tx, tenant, {
        conversationId,
        reasonCode: "guest_asked_human",
        detail: "the guest asked for a person",
        at: new Date("2026-10-25T16:00:00Z"),
      }),
    );
    expect(state).toBe("awaiting_staff");
    expect(await readState(conversationId)).toBe("awaiting_staff");

    const reasons = await client.query<{ reason_code: string; detail: string }>(
      "SELECT reason_code, detail FROM handoff_reasons WHERE conversation_id = $1",
      [conversationId],
    );
    expect(reasons.rows).toEqual([
      { reason_code: "guest_asked_human", detail: "the guest asked for a person" },
    ]);

    const events = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE conversation_id = $1 AND event_type = 'human_takeover'",
      [conversationId],
    );
    expect(Number(events.rows[0]!.n)).toBe(1);

    // Idempotent: a second agent taking the same conversation adds nothing.
    expect(await asApp((tx) => takeover(tx, tenant, { conversationId, reasonCode: "guest_asked_human" }))).toBe(
      "awaiting_staff",
    );
    const after = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM handoff_reasons WHERE conversation_id = $1",
      [conversationId],
    );
    expect(Number(after.rows[0]!.n)).toBe(1);
  });

  it("stops the model speaking once a human owns the thread (AC-2)", async () => {
    const conversationId = await newConversation();
    await seedState(conversationId, "awaiting_ai");
    await asApp((tx) => takeover(tx, tenant, { conversationId, reasonCode: "guest_asked_human" }));

    await expect(
      asApp((tx) => assertModelMaySpeak(tx, tenant, conversationId)),
    ).rejects.toBeInstanceOf(StaffTookOverError);

    // Handing it back is the one transition that re-arms the model.
    await asApp((tx) => transition(tx, tenant, conversationId, "awaiting_ai"));
    expect(await asApp((tx) => assertModelMaySpeak(tx, tenant, conversationId))).toBe("awaiting_ai");
  });

  it("serialises a takeover against an in-flight AI turn on the same row lock", async () => {
    const conversationId = await newConversation();

    // 1. The AI's transaction takes the row lock and keeps it.
    await second.query("BEGIN");
    await second.query("SET LOCAL ROLE concierge_app");
    await second.query("SELECT set_config('app.current_org_id', $1, true)", [tenant.orgId]);
    await second.query("SELECT set_config('app.current_property_id', $1, true)", [tenant.propertyId]);
    const locked = await lockState(second, tenant, conversationId);
    expect(locked).toBe("idle");
    await second.query("UPDATE conversations SET ai_state = 'awaiting_ai' WHERE conversation_id = $1", [
      conversationId,
    ]);

    // 2. A takeover arrives and must WAIT: it is queued on the same lock.
    let takeoverDone = false;
    const pending = asApp(async (tx) => {
      const result = await takeover(tx, tenant, {
        conversationId,
        reasonCode: "guest_asked_human",
      });
      takeoverDone = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(takeoverDone).toBe(false);

    // 3. The AI finishes its turn first: it wrote its message BEFORE the
    //    takeover existed, which is the only ordering that is allowed.
    await second.query("COMMIT");
    expect(await pending).toBe("awaiting_staff");
    expect(takeoverDone).toBe(true);

    // 4. And the next turn is refused, so nothing follows the takeover.
    await expect(
      asApp((tx) => assertModelMaySpeak(tx, tenant, conversationId)),
    ).rejects.toBeInstanceOf(StaffTookOverError);
  });

  it("answers a guest honestly — and does not call the model — after a takeover", async () => {
    // The guest path is driven through a real conversation row.
    const created = await client.query<{ conversation_id: string }>(
      `INSERT INTO conversations (org_id, property_id, connection_id, ai_state)
       VALUES ($1, $2, $3, 'awaiting_staff') RETURNING conversation_id`,
      [tenant.orgId, tenant.propertyId, channelId],
    );
    const conversationId = created.rows[0]!.conversation_id;

    const provider = createScriptedProvider([{}], "stub-primary-2026-01-01");
    const turn = await postGuestMessage(
      {
        ai: withResilience(provider, createScriptedProvider([{}], "stub-fallback-2026-01-01"), {
          retries: 0,
          sleep: async () => {},
          now: () => 0,
        }),
        cookieSecret: SECRET,
        now: () => new Date("2026-10-25T16:30:00Z"),
      },
      client,
      {
        slug: "state",
        ticket: await freshTicket(conversationId),
        text: "¿Sigue ahí?",
        language: "es",
      },
    );

    expect(turn.decision).toBe("handoff");
    expect(turn.reasonCode).toBe("awaiting_staff");
    expect(turn.messages[1]!.body).toBe(t("guest.staff_reply_pending", "es"));
    // The model was never asked: a takeover is not a prompt.
    expect(provider.requests).toHaveLength(0);
    expect(await readState(conversationId)).toBe("awaiting_staff");
  });

  /** A ticket pointing at an existing conversation, minted the way the API does. */
  async function freshTicket(conversationId: string): Promise<GuestTicket> {
    const identity = await client.query<{ identity_id: string }>(
      `INSERT INTO channel_identities (org_id, property_id, connection_id, external_id)
       VALUES ($1, $2, $3, $4) RETURNING identity_id`,
      [tenant.orgId, tenant.propertyId, channelId, `state:${conversationId}`],
    );
    await client.query("UPDATE conversations SET identity_id = $2 WHERE conversation_id = $1", [
      conversationId,
      identity.rows[0]!.identity_id,
    ]);
    const ticket = verifyGuestTicket(
      signGuestTicket(
        {
          identityId: identity.rows[0]!.identity_id,
          conversationId,
          propertyId: tenant.propertyId,
        },
        SECRET,
      ),
      SECRET,
    );
    if (ticket === null) throw new Error("test ticket did not verify");
    return ticket;
  }
});
