/**
 * S09-05 — a request reaches a human by email.
 *
 * AC-1: every new/acknowledged request enqueues an email to the property's
 * escalation contacts.
 * AC-2: recipients come from settings, a property with none falls back to a
 * configured address, and provider failure retries via the outbox without ever
 * losing the notification.
 *
 * The unit suite covers composition and config. This file covers the three things
 * only a database can show:
 *
 * 1. **Same commit.** The row is written inside the request's transaction, so there
 *    is no window where the request exists and nothing has decided to send mail. A
 *    rollback has to take the notification with it, and a commit has to make it
 *    visible to a session that was not part of the turn.
 * 2. **Survival.** A provider that fails leaves a row with attempts and a future
 *    due-time, not a silence. Exhausting the retries leaves a `dead` row and an
 *    audit entry naming the cause — the escalation failed, and that is knowable.
 * 3. **Separation.** `claim_outbox` is the one cross-tenant read in the system, so
 *    this is the file that has to prove property A's escalation cannot be answered
 *    from property B's settings, and that the guest's words never ride through the
 *    definer window in a payload.
 *
 * Delivery itself is not proven here and is not proven anywhere yet: DEC-4 closed on
 * Resend but not on credentials, so §7's "a real delivered email" is recorded as
 * outstanding evidence. The provider is a `logOnlyProvider` that records what it was
 * asked to send; the single HTTP call has its own contract test against an injected
 * fetch in tests/notifications/email.test.ts.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireRole, type StaffSession } from "../../src/auth/context.ts";
import type { Role } from "../../src/auth/guard.ts";
import {
  EMAIL_MAX_ATTEMPTS,
  EMAIL_OUTBOX_KIND,
  enqueueEmail,
  loadEmailConfig,
  processEmailOutbox,
  type EmailConfig,
} from "../../src/notifications/email.ts";
import { logOnlyProvider } from "../../src/providers/email.ts";
import { captureRequest } from "../../src/requests/capture.ts";
import { transitionRequest } from "../../src/requests/lifecycle.ts";
import { DEFAULT_SETTINGS, type EscalationContact, type PropertySettings } from "../../src/settings/schema.ts";
import { connectScratch, dropScratch, recreateScratch, scratchUrl } from "./helpers.db.ts";

const GUEST_TEXT = "No hay agua caliente en la habitación 402, por favor";
const SLUG_A = "email-a";
const SLUG_B = "email-b";
const SLUG_C = "email-c";

const DESK_A = "recepcion@casamesa-a.example";
const DESK_B = "front@casamesa-b.example";
const FALLBACK = "oncall@operator.example";

let client: pg.Client;
let pool: pg.Pool;

interface Tenant {
  orgId: string;
  propertyId: string;
  conversationId: string;
  slug: string;
}
let a: Tenant;
let b: Tenant;
let c: Tenant;
/** Owner on A, for the acknowledged edge (0024 requires a real member actor). */
let staffUuid = "";

/** Config as production would resolve it: a key and a fallback both present. */
const config: EmailConfig = loadEmailConfig(
  {
    EMAIL_FROM: "Concierge <desk@casamesa.example>",
    EMAIL_API_KEY: "re_test_key",
    EMAIL_ESCALATION_FALLBACK: FALLBACK,
    CONSOLE_BASE_URL: "https://console.example",
  },
  "prod",
);
/** The same, with nowhere to fall back to — the loud-refusal case. */
const noFallback: EmailConfig = { ...config, fallbackRecipient: null };

function settingsWith(contacts: EscalationContact[]): PropertySettings {
  return { ...DEFAULT_SETTINGS, escalation: { contacts } };
}

async function seedProperty(slug: string, contacts: EscalationContact[]): Promise<Tenant> {
  const org = await client.query<{ org_id: string }>(
    "INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING org_id",
    [`org_${slug}`],
  );
  const orgId = org.rows[0]!.org_id;
  const property = await client.query<{ property_id: string }>(
    `INSERT INTO properties (org_id, name, slug, time_zone, settings)
     VALUES ($1, $2, $2, 'America/Mexico_City', $3::jsonb) RETURNING property_id`,
    [orgId, slug, JSON.stringify(settingsWith(contacts))],
  );
  const channel = await client.query<{ channel_connection_id: string }>(
    "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web') RETURNING channel_connection_id",
    [orgId, property.rows[0]!.property_id],
  );
  const conversation = await client.query<{ conversation_id: string }>(
    "INSERT INTO conversations (org_id, property_id, connection_id) VALUES ($1, $2, $3) RETURNING conversation_id",
    [orgId, property.rows[0]!.property_id, channel.rows[0]!.channel_connection_id],
  );
  return { orgId, propertyId: property.rows[0]!.property_id, conversationId: conversation.rows[0]!.conversation_id, slug };
}

/**
 * A fresh conversation on an existing property.
 *
 * `captureRequest` reuses an open request per conversation — one problem, one
 * request — so a test that wants a *new* queued notification needs a new
 * conversation. Sharing one across tests made every test after the first queue
 * nothing at all.
 */
async function seedConversation(tenant: Tenant): Promise<string> {
  const channel = await client.query<{ channel_connection_id: string }>(
    "SELECT channel_connection_id FROM channel_connections WHERE property_id = $1 LIMIT 1",
    [tenant.propertyId],
  );
  const row = await client.query<{ conversation_id: string }>(
    "INSERT INTO conversations (org_id, property_id, connection_id) VALUES ($1, $2, $3) RETURNING conversation_id",
    [tenant.orgId, tenant.propertyId, channel.rows[0]!.channel_connection_id],
  );
  return row.rows[0]!.conversation_id;
}

/** A real inbound guest message, so the email has something to quote. */
async function seedMessage(tenant: Tenant, conversationId: string, body = GUEST_TEXT): Promise<string> {
  const row = await client.query<{ message_id: string }>(
    `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body, created_at)
     VALUES ($1, $2, $3, 'inbound', 'guest', $4, clock_timestamp()) RETURNING message_id`,
    [tenant.orgId, tenant.propertyId, conversationId, body],
  );
  return row.rows[0]!.message_id;
}

interface EmailRow {
  outbox_id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  processed_at: Date | null;
  last_error: string | null;
  payload: Record<string, unknown>;
}

async function emailRows(propertyId?: string): Promise<EmailRow[]> {
  const rows = await client.query<EmailRow>(
    `SELECT outbox_id::text, status, attempts, next_attempt_at, processed_at, last_error, payload
       FROM outbox WHERE kind = 'email' ${propertyId === undefined ? "" : "AND property_id = $1"}
      ORDER BY outbox_id`,
    propertyId === undefined ? [] : [propertyId],
  );
  return rows.rows;
}

async function rowsFor(requestId: string): Promise<EmailRow[]> {
  const all = await emailRows();
  return all.filter((r) => r.payload["request_id"] === requestId);
}

interface AuditRow {
  action: string;
  actor_user_id: string | null;
  entity_id: string;
  detail: Record<string, unknown>;
}

async function audits(action: string, entityId?: string): Promise<AuditRow[]> {
  const rows = await client.query<AuditRow>(
    `SELECT action, actor_user_id::text, entity_id, detail FROM audit_log
      WHERE action = $1 ${entityId === undefined ? "" : "AND entity_id = $2"}
      ORDER BY audit_id`,
    entityId === undefined ? [action] : [action, entityId],
  );
  return rows.rows;
}

interface CaptureOptions {
  /** Reuse an existing conversation instead of opening one — the "one problem, one
   * request" case is the only one that wants this. */
  conversationId?: string;
  /** Null means the guest tapped "Talk to a person" and wrote nothing. */
  messageBody?: string | null;
  topic?: "needs_human" | "guest_requested_human";
}

interface Captured {
  requestId: string;
  created: boolean;
  conversationId: string;
  messageId: string | null;
}

/** One capture, in a transaction shaped like the guest turn's. */
async function capture(tenant: Tenant, options: CaptureOptions = {}): Promise<Captured> {
  const conversationId = options.conversationId ?? (await seedConversation(tenant));
  const body = options.messageBody === undefined ? GUEST_TEXT : options.messageBody;
  const messageId = body === null ? null : await seedMessage(tenant, conversationId, body);

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenant.orgId]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [tenant.propertyId]);
    const captured = await captureRequest(client, { orgId: tenant.orgId, propertyId: tenant.propertyId }, {
      conversationId,
      topic: options.topic ?? "needs_human",
      question: body ?? GUEST_TEXT,
      language: "es",
      messageId,
    });
    await client.query("COMMIT");
    return { ...captured, conversationId, messageId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function session(userUuid: string): StaffSession {
  const role: Role = "owner";
  return {
    userUuid,
    role,
    requireRole: (surface, mode) => requireRole(role, surface, mode),
  };
}

async function acknowledge(tenant: Tenant, requestId: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenant.orgId]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [tenant.propertyId]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [staffUuid]);
    await transitionRequest(
      client,
      { orgId: tenant.orgId, propertyId: tenant.propertyId },
      session(staffUuid),
      requestId,
      "acknowledged",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function assign(tenant: Tenant, requestId: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenant.orgId]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [tenant.propertyId]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [staffUuid]);
    await transitionRequest(
      client,
      { orgId: tenant.orgId, propertyId: tenant.propertyId },
      session(staffUuid),
      requestId,
      "assigned",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Makes a failed row due again, the way a passing minute would. */
async function makeDue(outboxId: string): Promise<void> {
  await client.query(
    "UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE outbox_id = $1",
    [outboxId],
  );
}

describe("email outbox (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    pool = new pg.Pool({ connectionString: scratchUrl(), max: 4 });

    a = await seedProperty(SLUG_A, [{ name: "Recepción", channel: "email", value: DESK_A }]);
    b = await seedProperty(SLUG_B, [{ name: "Front desk", channel: "email", value: DESK_B }]);
    // No contacts at all: the fallback and loud-refusal cases.
    c = await seedProperty(SLUG_C, []);

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE concierge_app");
    const user = await client.query<{ user_id: string }>(
      "SELECT provision_user($1, $2, $3) AS user_id",
      ["auth|email-owner", "owner@email-a.mx", "Owner"],
    );
    staffUuid = user.rows[0]!.user_id;
    await client.query("COMMIT");
    await client.query(
      "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 1)",
      [staffUuid, a.propertyId],
    );
  });

  beforeEach(async () => {
    // The worker claims across every tenant, so a row an earlier test left pending
    // would be processed by a later one and every `processed: 1` would be a lie.
    // `outbox` is not append-only (0003 covers events, audit_log and
    // article_versions), and this client is the superuser, so clearing it is legal.
    // Audit rows are kept: they are the evidence, and every assertion on them is
    // filtered by request id, which is unique per test.
    await client.query("DELETE FROM outbox WHERE kind = 'email'");
  });

  afterAll(async () => {
    await pool.end();
    await client.end();
    await dropScratch();
  });

  describe("AC-1 — queued in the request's own transaction", () => {
    it("writes the request and the notification in one commit", async () => {
      const captured = await capture(a);
      expect(captured.created).toBe(true);

      // Visible from a session that was not part of the turn, which is what
      // "committed" means — and still untouched, because nothing has run the worker.
      const rows = await rowsFor(captured.requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "pending", attempts: 0, processed_at: null });
      expect(rows[0]!.payload).toMatchObject({
        request_id: captured.requestId,
        conversation_id: captured.conversationId,
        stage: "new",
        dedupe_key: `${captured.requestId}:new`,
      });
    });

    it("takes the notification with the request when the transaction rolls back", async () => {
      // The other half of sharing a commit. A notification that survived a request
      // that did not would announce something that never happened.
      const before = (await emailRows()).length;
      const conversationId = await seedConversation(a);
      const messageId = await seedMessage(a, conversationId);
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE concierge_app");
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [a.orgId]);
        await client.query("SELECT set_config('app.current_property_id', $1, true)", [a.propertyId]);
        await captureRequest(client, { orgId: a.orgId, propertyId: a.propertyId }, {
          conversationId,
          topic: "needs_human",
          question: GUEST_TEXT,
          language: "es",
          messageId,
        });
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      expect(await emailRows()).toHaveLength(before);
    });

    it("keeps the guest's words out of the payload that crosses tenants", async () => {
      // `claim_outbox` is SECURITY DEFINER and returns `payload` before any tenant
      // context exists, so the payload is the one place in this flow that is
      // readable across every property. It carries ids; the body stays in
      // `messages`, behind the tenant policy.
      const captured = await capture(a, { messageBody: "Tarjeta rechazada, ayuda urgente" });
      const row = (await rowsFor(captured.requestId))[0]!;
      const serialised = JSON.stringify(row.payload);
      expect(serialised).not.toContain("Tarjeta");
      expect(serialised).not.toContain("ayuda urgente");
      expect(serialised).not.toContain("402");
      expect(Object.keys(row.payload).sort()).toEqual(
        ["conversation_id", "dedupe_key", "message_id", "request_id", "stage"].sort(),
      );
    });

    it("does not re-announce a request that was reused", async () => {
      const first = await capture(a);
      // Same conversation on purpose: this is the case where captureRequest finds an
      // open request and reuses it, which is what makes it one announcement.
      const second = await capture(a, { conversationId: first.conversationId });
      expect(second.requestId).toBe(first.requestId);
      expect(second.created).toBe(false);
      expect(await rowsFor(first.requestId)).toHaveLength(1);
    });

    it("queues one row when the same request+stage is enqueued twice", async () => {
      // A phone on a bad connection submits twice. 0028's partial unique index is
      // what makes that one email rather than two, and `enqueueEmail` reports it
      // instead of throwing — inside the guest's transaction, a throw would take the
      // request down with it.
      const captured = await capture(b);
      const again = await enqueueEmail(client, {
        orgId: b.orgId,
        propertyId: b.propertyId,
        requestId: captured.requestId,
        conversationId: b.conversationId,
        messageId: null,
        stage: "new",
      });
      expect(again).toMatchObject({ queued: false, deduped: true, outboxId: null });
      expect(await rowsFor(captured.requestId)).toHaveLength(1);
    });

    it("queues a second notification on the acknowledged edge", async () => {
      const captured = await capture(a);
      await acknowledge(a, captured.requestId);

      const rows = await rowsFor(captured.requestId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.payload["stage"]).sort()).toEqual(["acknowledged", "new"]);
      // The acknowledgement announces a staff action, so it quotes nobody.
      expect(rows[1]!.payload["message_id"]).toBeNull();
    });

    it("queues nothing on the assigned edge", async () => {
      // Emailing every status change turns the escalation channel into noise, which
      // is how the one notification that mattered gets filtered along with the rest.
      const captured = await capture(a);
      await acknowledge(a, captured.requestId);
      const before = (await rowsFor(captured.requestId)).length;
      await assign(a, captured.requestId);
      expect(await rowsFor(captured.requestId)).toHaveLength(before);
    });

    it("audits the enqueue, with an actor only when a person caused it", async () => {
      const captured = await capture(a);
      await acknowledge(a, captured.requestId);

      const queued = await audits("notification.queued", captured.requestId);
      expect(queued).toHaveLength(2);
      // The guest is not a `users` row; attributing a system notification to a
      // person would be a false record.
      expect(queued[0]!.actor_user_id).toBeNull();
      expect(queued[0]!.detail).toMatchObject({ stage: "new" });
      expect(queued[1]!.actor_user_id).toBe(staffUuid);
      expect(queued[1]!.detail).toMatchObject({ stage: "acknowledged" });
    });
  });

  describe("AC-2 — a provider failure never loses the notification", () => {
    it("sends to the property's own contacts and marks the row sent", async () => {
      const provider = logOnlyProvider();
      const captured = await capture(a);

      const tally = await processEmailOutbox(pool, provider, config);
      expect(tally).toMatchObject({ processed: 1, sent: 1, retried: 0, dead: 0 });

      const row = (await rowsFor(captured.requestId))[0]!;
      expect(row.status).toBe("sent");
      expect(row.attempts).toBe(1);
      expect(row.processed_at).not.toBeNull();
      expect(row.next_attempt_at).toBeNull();
      expect(row.last_error).toBeNull();

      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]!.to).toEqual([DESK_A]);
      // The property's own contacts are inside the property's access boundary, so
      // they get the guest's words and a link they can act on.
      expect(provider.sent[0]!.text).toContain(GUEST_TEXT);
      expect(provider.sent[0]!.text).toContain(`https://console.example/inbox/${captured.conversationId}`);
      // §7: the subject carries the property and the request id, and nothing the
      // guest wrote.
      expect(provider.sent[0]!.subject).not.toContain("402");
      expect(provider.sent[0]!.subject).not.toContain("agua caliente");

      const sent = await audits("notification.sent", captured.requestId);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.detail).toMatchObject({ recipientSource: "property", recipientCount: 1, redacted: false });
      // The provider's own id is the delivery evidence that is not ours to invent.
      expect(sent[0]!.detail["providerId"]).toBe("log-1");
      // Recipients are counted, never listed: an address is PII.
      expect(JSON.stringify(sent[0]!.detail)).not.toContain(DESK_A);
    });

    it("retries a transient failure and keeps the row", async () => {
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: true, reason: "unavailable", detail: "provider down" };
      const captured = await capture(b);

      const tally = await processEmailOutbox(pool, provider, config);
      expect(tally).toMatchObject({ processed: 1, sent: 0, retried: 1, dead: 0 });

      // The row is the guarantee: a provider down for an hour produces a queue, not
      // a silence. It still exists, it has been attempted, and it is due again.
      const row = (await rowsFor(captured.requestId))[0]!;
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain("provider down");
      expect(row.next_attempt_at).not.toBeNull();
      expect(row.next_attempt_at!.getTime()).toBeGreaterThan(Date.now() - 5_000);
      expect(provider.sent).toHaveLength(0);
      // A retry is not a death: nothing is audited as dead yet.
      expect(await audits("notification.dead", captured.requestId)).toHaveLength(0);
    });

    it("does not claim a row whose retry is not due yet", async () => {
      // Ignoring next_attempt_at would turn backoff into a no-op and hammer a
      // provider that is already refusing.
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: true, reason: "unavailable" };
      const captured = await capture(a);
      await processEmailOutbox(pool, provider, config);
      expect((await rowsFor(captured.requestId))[0]!.attempts).toBe(1);

      const again = await processEmailOutbox(pool, provider, config);
      expect(again.processed).toBe(0);
      expect((await rowsFor(captured.requestId))[0]!.attempts).toBe(1);
    });

    it("succeeds on a later attempt once the row is due", async () => {
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: true, reason: "unavailable" };
      const captured = await capture(a);
      await processEmailOutbox(pool, provider, config);
      const row = (await rowsFor(captured.requestId))[0]!;
      expect(row.status).toBe("failed");

      // The provider recovers, and time passes.
      provider.failWith = null;
      await makeDue(row.outbox_id);
      const tally = await processEmailOutbox(pool, provider, config);
      expect(tally).toMatchObject({ processed: 1, sent: 1 });

      const after = (await rowsFor(captured.requestId))[0]!;
      expect(after.status).toBe("sent");
      expect(after.attempts).toBe(2);
      expect(after.last_error).toBeNull();
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]!.to).toEqual([DESK_A]);
    });

    it("gives up on a permanent refusal on the first attempt", async () => {
      // A rejected sender domain or an invalid key will refuse identically five
      // times. Burning the retries produces a dead row that looks exactly like an
      // outage and sends the operator looking in the wrong place.
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: false, reason: "rejected", detail: "invalid api key" };
      const captured = await capture(a);

      const tally = await processEmailOutbox(pool, provider, config);
      expect(tally).toMatchObject({ processed: 1, retried: 0, dead: 1 });

      const row = (await rowsFor(captured.requestId))[0]!;
      expect(row.status).toBe("dead");
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain("invalid api key");

      const dead = await audits("notification.dead", captured.requestId);
      expect(dead).toHaveLength(1);
      expect(dead[0]!.detail).toMatchObject({ reason: "rejected", attempts: 1 });
      expect(dead[0]!.actor_user_id).toBeNull();
    });

    it("goes dead after exhausting its retries", async () => {
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: true, reason: "unavailable" };
      const captured = await capture(b);

      for (let attempt = 1; attempt <= EMAIL_MAX_ATTEMPTS; attempt += 1) {
        const row = (await rowsFor(captured.requestId))[0]!;
        if (attempt > 1) await makeDue(row.outbox_id);
        await processEmailOutbox(pool, provider, config);
        const after = (await rowsFor(captured.requestId))[0]!;
        expect(after.attempts).toBe(attempt);
        if (attempt < EMAIL_MAX_ATTEMPTS) expect(after.status).toBe("failed");
      }

      const row = (await rowsFor(captured.requestId))[0]!;
      expect(row.status).toBe("dead");
      expect(row.attempts).toBe(EMAIL_MAX_ATTEMPTS);
      // "When did we give up" is answerable from the row, via processed_at — and
      // next_attempt_at is NULL, because a timestamp there would read as a retry
      // that was missed rather than as a queue that was closed.
      expect(row.processed_at).not.toBeNull();
      expect(row.next_attempt_at).toBeNull();
      expect(provider.sent).toHaveLength(0);
      expect((await audits("notification.dead", captured.requestId))[0]!.detail).toMatchObject({
        reason: "unavailable",
        attempts: EMAIL_MAX_ATTEMPTS,
      });
    });

    it("never sends a guest message as part of retrying", async () => {
      // The retry path holds a provider and nothing else: it cannot post to the
      // conversation. Counted rather than assumed, because the count is what a guest
      // would notice.
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: true, reason: "unavailable" };
      const captured = await capture(a);
      await processEmailOutbox(pool, provider, config);
      await makeDue((await rowsFor(captured.requestId))[0]!.outbox_id);
      await processEmailOutbox(pool, provider, config);

      const messages = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1 AND direction = 'outbound'",
        [captured.conversationId],
      );
      expect(Number(messages.rows[0]!.n)).toBe(0);
    });
  });

  describe("AC-2 — recipients come from settings, with a fallback", () => {
    it("uses the deployment fallback when the property has no contacts", async () => {
      const provider = logOnlyProvider();
      const captured = await capture(c);

      const tally = await processEmailOutbox(pool, provider, config);
      expect(tally).toMatchObject({ sent: 1, dead: 0 });
      expect(provider.sent[0]!.to).toEqual([FALLBACK]);

      // The fallback is operator level, not scoped to this property, so it gets the
      // pointer and not the content: forwarding one property's guest conversation to
      // an address outside that property's access boundary would be a disclosure.
      expect(provider.sent[0]!.text).not.toContain(GUEST_TEXT);
      expect(provider.sent[0]!.text).not.toContain("402");
      expect(provider.sent[0]!.text).toContain(captured.requestId);
      expect(provider.sent[0]!.text).toContain(`https://console.example/inbox/${captured.conversationId}`);

      const sent = await audits("notification.sent", captured.requestId);
      expect(sent[0]!.detail).toMatchObject({ recipientSource: "fallback", redacted: true });
    });

    it("refuses loudly when there is nobody at all", async () => {
      // The case that must never be quiet. A guest asked for a person; the system
      // has to say it failed rather than record that it handled it.
      const provider = logOnlyProvider();
      const captured = await capture(c);

      const tally = await processEmailOutbox(pool, provider, noFallback);
      expect(tally).toMatchObject({ processed: 1, sent: 0, dead: 1, noRecipient: 1 });
      expect(provider.sent).toHaveLength(0);

      const row = (await rowsFor(captured.requestId))[0]!;
      expect(row.status).toBe("dead");
      expect(row.last_error).toContain("no_recipient");
      // Not retried: nothing about the property's settings changes between attempt
      // one and attempt two.
      expect(row.attempts).toBe(1);

      const dead = await audits("notification.dead", captured.requestId);
      expect(dead).toHaveLength(1);
      expect(dead[0]!.detail).toMatchObject({ reason: "no_recipient" });
    });

    it("does not count an in_app contact as an address", async () => {
      // The inbox is a different delivery path. Emailing an in-app handle would mean
      // sending to a string that is not an address, and the provider would reject it
      // five times before going dead.
      const tenant = await seedProperty("email-inapp", [
        { name: "Recepción", channel: "in_app", value: "reception-desk" },
      ]);
      const provider = logOnlyProvider();
      const captured = await capture(tenant);
      await processEmailOutbox(pool, provider, config);

      expect(provider.sent[0]!.to).toEqual([FALLBACK]);
      expect((await audits("notification.sent", captured.requestId))[0]!.detail).toMatchObject({
        recipientSource: "fallback",
      });
    });

    it("sends to every contact the property configured, once each", async () => {
      const tenant = await seedProperty("email-many", [
        { name: "Recepción", channel: "email", value: "desk@many.example" },
        { name: "Gerente", channel: "email", value: "gm@many.example" },
        { name: "Duplicado", channel: "email", value: "DESK@many.example" },
        { name: "Mal escrito", channel: "email", value: "nope" },
      ]);
      const provider = logOnlyProvider();
      await capture(tenant);
      await processEmailOutbox(pool, provider, config);

      expect(provider.sent[0]!.to).toEqual(["desk@many.example", "gm@many.example"]);
    });

    it("a dead row does not block a later notification for the same stage", async () => {
      // 0028's index is partial on purpose: `dead` is exactly the case where an
      // operator fixes the settings and re-queues by hand.
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: false, reason: "rejected" };
      const captured = await capture(a);
      await processEmailOutbox(pool, provider, config);
      expect((await rowsFor(captured.requestId))[0]!.status).toBe("dead");

      const requeued = await enqueueEmail(client, {
        orgId: a.orgId,
        propertyId: a.propertyId,
        requestId: captured.requestId,
        conversationId: a.conversationId,
        messageId: null,
        stage: "new",
      });
      expect(requeued.queued).toBe(true);
      expect(await rowsFor(captured.requestId)).toHaveLength(2);
    });
  });

  describe("a retry cannot deliver twice (review #3)", () => {
    it("carries the same idempotency key on every attempt of one row", async () => {
      // 0028's dedupe index stops a second outbox ROW for one request+stage. It does
      // nothing about a second DELIVERY of the row that already exists: if Resend
      // accepts the email and the response is lost — a stalled body, a reset
      // connection, a process killed before the `sent` commit — the row is still
      // claimable and a naive retry sends it again. The provider-side key is the only
      // thing that closes that, so the key has to be observable on the FAILED attempt
      // too, which is why the log-only provider records attempts and not just sends.
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: true, reason: "unavailable" };
      const captured = await capture(a);

      await processEmailOutbox(pool, provider, config);
      expect(provider.attempts).toHaveLength(1);
      expect(provider.sent).toHaveLength(0);
      const firstKey = provider.attempts[0]!.idempotencyKey;

      const row = (await rowsFor(captured.requestId))[0]!;
      expect(firstKey).toBe(`concierge-email/${row.outbox_id}`);

      // The provider recovers and the row becomes due: the retry must reuse the key.
      provider.failWith = null;
      await makeDue(row.outbox_id);
      await processEmailOutbox(pool, provider, config);

      expect(provider.attempts).toHaveLength(2);
      expect(provider.attempts[1]!.idempotencyKey).toBe(firstKey);
      expect(provider.sent).toHaveLength(1);
    });

    it("gives a re-queued row a different key, so a deliberate re-send is not suppressed", async () => {
      // The other half of keying on the row rather than on request+stage: Resend
      // remembers keys for 24 hours, so a key derived from the dedupe key would
      // silently swallow an operator's re-queue of a dead row for a whole day.
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: false, reason: "rejected" };
      const captured = await capture(a);
      await processEmailOutbox(pool, provider, config);
      expect((await rowsFor(captured.requestId))[0]!.status).toBe("dead");

      const requeued = await enqueueEmail(client, {
        orgId: a.orgId,
        propertyId: a.propertyId,
        requestId: captured.requestId,
        conversationId: captured.conversationId,
        messageId: captured.messageId,
        stage: "new",
      });
      expect(requeued.queued).toBe(true);

      provider.failWith = null;
      await processEmailOutbox(pool, provider, config);
      expect(provider.attempts).toHaveLength(2);
      expect(provider.attempts[1]!.idempotencyKey).not.toBe(provider.attempts[0]!.idempotencyKey);
      expect(provider.attempts[1]!.idempotencyKey).toBe(`concierge-email/${requeued.outboxId?.toString()}`);
    });

    it("retries an in-flight conflict rather than giving up on it", async () => {
      // Resend answers 409 concurrent_idempotent_requests while the first attempt is
      // still running; that is a "come back in a moment", not a refusal.
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: true, reason: "conflict_in_flight" };
      const captured = await capture(a);

      const tally = await processEmailOutbox(pool, provider, config);
      expect(tally).toMatchObject({ retried: 1, dead: 0 });
      expect((await rowsFor(captured.requestId))[0]!.status).toBe("failed");
    });

    it("gives up on a payload conflict without claiming it was sent", async () => {
      // Same key, different payload: an earlier attempt WAS accepted and its content
      // is not what we would send now. Reporting `sent` would claim a delivery whose
      // content we cannot prove, and retrying 409s forever — so it is a dead row with
      // its own reason for a human to look at.
      const provider = logOnlyProvider();
      provider.failWith = { ok: false, providerId: null, retryable: false, reason: "conflict_payload", detail: "key reused" };
      const captured = await capture(a);

      const tally = await processEmailOutbox(pool, provider, config);
      expect(tally).toMatchObject({ sent: 0, dead: 1 });
      expect(provider.sent).toHaveLength(0);

      const row = (await rowsFor(captured.requestId))[0]!;
      expect(row.status).toBe("dead");
      expect(row.last_error).toContain("conflict_payload");
      expect((await audits("notification.dead", captured.requestId))[0]!.detail).toMatchObject({
        reason: "conflict_payload",
      });
      // Nothing was recorded as delivered.
      expect(await audits("notification.sent", captured.requestId)).toHaveLength(0);
    });
  });

  describe("a detached conversation (review #4)", () => {
    it("sends no console link when the conversation is gone", async () => {
      // 0001 sets service_requests.conversation_id to NULL on conversation delete and
      // the request row survives. The detail page is keyed by conversation id, so
      // there is no link to give: printing `${base}/inbox/` would render as a real URL
      // resolving to the inbox index or a 404, which reads as a console bug rather
      // than as a deleted conversation.
      const provider = logOnlyProvider();
      const captured = await capture(a);
      await client.query(
        "UPDATE service_requests SET conversation_id = NULL WHERE request_id = $1",
        [captured.requestId],
      );

      const tally = await processEmailOutbox(pool, provider, config);
      expect(tally).toMatchObject({ sent: 1, dead: 0 });

      const email = provider.sent[0]!;
      expect(email.text).not.toContain("/inbox/");
      expect(email.text).not.toContain("Ábrela en la consola");
      expect(email.text).toContain("ya no está disponible");
      // Still worth receiving: the request and the guest's words are both there.
      expect(email.text).toContain(captured.requestId);
      expect(email.text).toContain(GUEST_TEXT);
      expect(email.to).toEqual([DESK_A]);
    });
  });

  describe("tenant separation across the one cross-tenant read", () => {
    it("answers each property from its own settings", async () => {
      // `claim_outbox` sees every tenant's rows; the work afterwards must not. A
      // worker that kept the wrong tenant context would email property B's contacts
      // about property A's guest.
      const provider = logOnlyProvider();
      const capturedA = await capture(a);
      const capturedB = await capture(b);

      const tally = await processEmailOutbox(pool, provider, config, 10);
      expect(tally.processed).toBe(2);
      expect(tally.sent).toBe(2);

      const toA = provider.sent.find((m) => m.subject.includes(capturedA.requestId))!;
      const toB = provider.sent.find((m) => m.subject.includes(capturedB.requestId))!;
      expect(toA.to).toEqual([DESK_A]);
      expect(toB.to).toEqual([DESK_B]);
      expect(toA.text).not.toContain(DESK_B);
      expect(toB.text).not.toContain(DESK_A);
      // Each got its own console link.
      expect(toA.text).toContain(`/inbox/${capturedA.conversationId}`);
      expect(toB.text).toContain(`/inbox/${capturedB.conversationId}`);
    });

    it("cannot be redirected by another tenant's settings", async () => {
      // The attack shape: a payload naming tenant A's request, claimed by a session
      // whose GUCs point at tenant B. The worker sets context from the CLAIMED ROW,
      // not from the session, so B's contacts are never consulted.
      const provider = logOnlyProvider();
      const captured = await capture(a);
      const row = (await rowsFor(captured.requestId))[0]!;

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE concierge_app");
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [b.orgId]);
      await client.query("SELECT set_config('app.current_property_id', $1, true)", [b.propertyId]);
      // Under B's context, A's request is not readable at all.
      const invisible = await client.query(
        "SELECT 1 FROM service_requests WHERE request_id = $1",
        [captured.requestId],
      );
      expect(invisible.rowCount).toBe(0);
      await client.query("ROLLBACK");

      await processEmailOutbox(pool, provider, config);
      expect(provider.sent[0]!.to).toEqual([DESK_A]);
      expect(provider.sent[0]!.to).not.toContain(DESK_B);
      expect((await rowsFor(captured.requestId))[0]!.outbox_id).toBe(row.outbox_id);
    });

    it("reads nothing when a payload names a request that is not there", async () => {
      // A retention sweep, or a hand-written payload. Not retryable: nothing will
      // make the request reappear, and a row that retries forever hides the real
      // problem.
      const provider = logOnlyProvider();
      const captured = await capture(a);
      await client.query("DELETE FROM service_requests WHERE request_id = $1", [captured.requestId]);

      const tally = await processEmailOutbox(pool, provider, config);
      expect(tally).toMatchObject({ processed: 1, sent: 0, dead: 1, retried: 0 });
      expect(provider.sent).toHaveLength(0);
      expect((await rowsFor(captured.requestId))[0]!.last_error).toContain("not readable");
    });

    it("composes without a quote when the message is gone", async () => {
      const provider = logOnlyProvider();
      const captured = await capture(a, { messageBody: "Se fue la luz en el pasillo" });
      expect(captured.messageId).not.toBeNull();
      await client.query("DELETE FROM messages WHERE message_id = $1", [captured.messageId]);

      await processEmailOutbox(pool, provider, config);
      // Still sent — the request exists and somebody should know — but it does not
      // print an empty "What the guest wrote:" block.
      expect(provider.sent[0]!.to).toEqual([DESK_A]);
      expect(provider.sent[0]!.text).not.toContain("Lo que escribió el huésped");
      expect(provider.sent[0]!.text).toContain(captured.requestId);
    });
  });

  describe("the claim primitive itself (0028)", () => {
    it("reaches every tenant, because outbox is FORCE RLS", async () => {
      // Without the definer function a worker sees zero rows — which looks exactly
      // like a healthy empty queue, so this is worth asserting directly.
      const queuedA = await capture(a);
      const queuedB = await capture(b);

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE concierge_app");
      const claimedA = await client.query<{ claimed_id: string }>(
        "SELECT * FROM claim_outbox($1, 1)",
        [EMAIL_OUTBOX_KIND],
      );
      expect(claimedA.rowCount).toBe(1);
      await client.query("ROLLBACK");
      void queuedA;
      void queuedB;
    });

    it("is not callable by PUBLIC and its owner cannot log in", async () => {
      const fn = await client.query<{ owner: string; definer: boolean; acl: string | null }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
                pg_catalog.array_to_string(p.proacl, '|') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'claim_outbox'`,
      );
      expect(fn.rows[0]).toMatchObject({ owner: "concierge_worker", definer: true });
      // ALTER ... OWNER discards the ACL and restores EXECUTE FOR PUBLIC, so this is
      // the assertion that catches a migration that forgot to re-tighten. A PUBLIC
      // grant is an entry with an EMPTY grantee — one that starts with '='. Checking
      // for the substring '=X/' would also match a named entry like
      // 'concierge_worker=X/concierge_worker' and fail on a correct ACL.
      const acl = fn.rows[0]!.acl;
      expect(acl).not.toBeNull();
      const entries = acl!.split("|");
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.filter((entry) => entry.startsWith("="))).toEqual([]);
      expect(entries).toContain("concierge_app=X/concierge_worker");
      // And nothing else may execute it: the definer body reads every tenant's rows.
      expect(entries).toHaveLength(2);

      const role = await client.query<{ rolcanlogin: boolean }>(
        "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'concierge_worker'",
      );
      expect(role.rows[0]!.rolcanlogin).toBe(false);
      // A login role left a member of the definer can SET ROLE into it and reach its
      // permissive policy — which here is every tenant's outbox.
      const member = await client.query<{ is_member: boolean }>(
        "SELECT pg_has_role('concierge_app', 'concierge_worker', 'MEMBER') AS is_member",
      );
      expect(member.rows[0]!.is_member).toBe(false);
    });

    it("retired the kind-specific claim rather than keeping two windows", async () => {
      const gone = await client.query(
        "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname='claim_review_outbox'",
      );
      expect(gone.rowCount).toBe(0);
      // And the review worker still claims through the general one.
      const still = await client.query<{ claimed_id: string }>(
        "SELECT * FROM claim_outbox('review', 1)",
      );
      expect(still.rowCount).toBe(0);
    });
  });
});
