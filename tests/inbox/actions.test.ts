/**
 * S08-03 — the half of the staff actions that can be wrong without a cluster.
 *
 * Two properties, both of them about ordering rather than about SQL:
 *
 *  1. **Authorisation runs before any query.** An observer who taps "reply" must
 *     not cause a single statement — not a lock, not a read, not a write. The
 *     database cases in `tests/db/inbox-actions.db.test.ts` prove the 403; this
 *     file proves the 403 costs nothing.
 *  2. **Input validation runs before the lock.** An empty message is a 400, not a
 *     transaction that takes a row lock and then rolls back, which would briefly
 *     block every other agent on the same conversation.
 *
 * The database semantics (idempotent takeover, assignment replay, resolve closing
 * the request) need real rows and live in the `.db.test.ts` file next door.
 */
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { StaffSession } from "../../src/auth/context.ts";
import { RoleNotOnSurfaceError } from "../../src/auth/guard.ts";
import { ConversationNotFoundError } from "../../src/inbox/detail.ts";
import {
  ActionInputError,
  MAX_STAFF_MESSAGE_CHARS,
  assignRequest,
  replyToConversation,
  resolveConversation,
  takeOverConversation,
} from "../../src/inbox/actions.ts";

const ORG = "11111111-1111-5111-a111-111111111111";
const PROP = "22222222-2222-5222-a222-222222222222";
const USER = "33333333-3333-5333-a333-333333333333";
const CONV = "44444444-4444-5444-a444-444444444444";

const CONTEXT = { orgId: ORG, propertyId: PROP };

/** A session whose requireRole passes or throws, and a client that records. */
function harness(options: { allowed?: boolean } = {}): {
  session: StaffSession;
  client: pg.Client;
  calls: string[];
} {
  const calls: string[] = [];
  const session: StaffSession = {
    userUuid: USER,
    role: options.allowed === false ? "observer" : "front_desk",
    requireRole: (surface, mode) => {
      if (options.allowed === false) throw new RoleNotOnSurfaceError("observer", surface, mode);
    },
  };
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Client;
  return { session, client, calls };
}

describe("staff actions: deny before doing anything (S08-03)", () => {
  it("an observer's attempts touch no table at all", async () => {
    const takeover = harness({ allowed: false });
    await expect(
      takeOverConversation(takeover.client, CONTEXT, takeover.session, { conversationId: CONV }),
    ).rejects.toBeInstanceOf(RoleNotOnSurfaceError);
    expect(takeover.calls).toEqual([]);

    const reply = harness({ allowed: false });
    await expect(
      replyToConversation(reply.client, CONTEXT, reply.session, { conversationId: CONV, body: "hola" }),
    ).rejects.toBeInstanceOf(RoleNotOnSurfaceError);
    expect(reply.calls).toEqual([]);

    const assign = harness({ allowed: false });
    await expect(
      assignRequest(assign.client, CONTEXT, assign.session, { conversationId: CONV }),
    ).rejects.toBeInstanceOf(RoleNotOnSurfaceError);
    expect(assign.calls).toEqual([]);

    const resolve = harness({ allowed: false });
    await expect(
      resolveConversation(resolve.client, CONTEXT, resolve.session, { conversationId: CONV }),
    ).rejects.toBeInstanceOf(RoleNotOnSurfaceError);
    expect(resolve.calls).toEqual([]);
  });
});

describe("staff actions: validate before locking (S08-03)", () => {
  it("refuses an empty message without taking the conversation's lock", async () => {
    const { session, client, calls } = harness();
    await expect(
      replyToConversation(client, CONTEXT, session, { conversationId: CONV, body: "   " }),
    ).rejects.toBeInstanceOf(ActionInputError);
    expect(calls).toEqual([]);
  });

  it("refuses a message longer than the guest's own ceiling", async () => {
    const { session, client, calls } = harness();
    await expect(
      replyToConversation(client, CONTEXT, session, {
        conversationId: CONV,
        body: "x".repeat(MAX_STAFF_MESSAGE_CHARS + 1),
      }),
    ).rejects.toBeInstanceOf(ActionInputError);
    expect(calls).toEqual([]);
    // Guests are capped at the same number (S07-01): a staff reply that no guest
    // message could match would break the transcript's symmetry for no reason.
    expect(MAX_STAFF_MESSAGE_CHARS).toBe(2000);
  });

  it("refuses a malformed conversation id without a query", async () => {
    const { session, client, calls } = harness();
    await expect(
      takeOverConversation(client, CONTEXT, session, { conversationId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(calls).toEqual([]);
  });

  it("treats an unknown conversation exactly like a foreign one", async () => {
    const { session, client } = harness();
    // The fake returns no rows, which is what RLS gives a foreign id.
    await expect(
      resolveConversation(client, CONTEXT, session, { conversationId: CONV }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});
