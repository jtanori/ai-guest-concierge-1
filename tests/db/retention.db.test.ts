/**
 * S11-03 / AC-2 — 90 days by default, with a documented deletion path.
 *
 * The dates are relative to `now()` rather than fixed, because the predicate is
 * relative to `now()`: a test pinned to a calendar date would start failing on a
 * Tuesday for no reason and then be "fixed" by widening the window.
 *
 * Two tenants in two orgs: retention is the one job in this repo whose bug is
 * irreversible, so "A's window does not touch B's text" is asserted rather than
 * assumed from the predicate looking right.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactExpiredMessages } from "../../src/security/retention.ts";
import type { TenantContext } from "../../src/db/tenant.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

let client: pg.Client;
let tenantA: TenantContext;
let tenantB: TenantContext;
let conversationA: string;
let conversationB: string;

const OLD = "91 days";
const RECENT = "89 days";

async function message(
  context: TenantContext,
  conversationId: string,
  body: string,
  age: string,
): Promise<string> {
  const created = await client.query<{ message_id: string }>(
    `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body, created_at)
     VALUES ($1, $2, $3, 'inbound', 'guest', $4, now() - ($5::text)::interval)
     RETURNING message_id`,
    [context.orgId, context.propertyId, conversationId, body, age],
  );
  return created.rows[0]!.message_id;
}

async function bodyOf(messageId: string): Promise<{ body: string; redacted: boolean }> {
  const row = await client.query<{ body: string; redacted: boolean }>(
    "SELECT body, body_redacted_at IS NOT NULL AS redacted FROM messages WHERE message_id = $1",
    [messageId],
  );
  return row.rows[0]!;
}

describe("retention for messages.body (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    const a = await seedTenant(client, "retention_a");
    tenantA = { orgId: a.orgId, propertyId: a.propertyId };
    conversationA = a.conversationId;
    const b = await seedTenant(client, "retention_b");
    tenantB = { orgId: b.orgId, propertyId: b.propertyId };
    conversationB = b.conversationId;
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("redacts 91-day-old text, keeps 89-day-old text, and says how many", async () => {
    const oldId = await message(tenantA, conversationA, "mi tarjeta era 4111 1111 1111 1111", OLD);
    const recentId = await message(tenantA, conversationA, "¿a qué hora abre la alberca?", RECENT);

    const dry = await redactExpiredMessages(client, tenantA, { days: 90, apply: false });
    expect(dry).toEqual({ days: 90, count: 1, applied: false });
    // A dry run that changed something would be the worst possible default.
    expect((await bodyOf(oldId)).body).toBe("mi tarjeta era 4111 1111 1111 1111");

    const applied = await redactExpiredMessages(client, tenantA, { days: 90, apply: true });
    expect(applied).toEqual({ days: 90, count: 1, applied: true });

    const redacted = await bodyOf(oldId);
    expect(redacted.body).toBe("");
    expect(redacted.redacted).toBe(true);

    const untouched = await bodyOf(recentId);
    expect(untouched.body).toBe("¿a qué hora abre la alberca?");
    expect(untouched.redacted).toBe(false);
  });

  it("is idempotent: a second run over the same window finds nothing", async () => {
    const again = await redactExpiredMessages(client, tenantA, { days: 90, apply: true });
    expect(again.count).toBe(0);
  });

  it("leaves events alone — aggregates outlive the text", async () => {
    const before = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM events WHERE property_id = $1",
      [tenantA.propertyId],
    );
    await client.query(
      `INSERT INTO events (org_id, property_id, conversation_id, channel, event_type, payload, created_at)
       VALUES ($1, $2, $3, 'web', 'message_received', '{"message_id":"old"}', now() - interval '200 days')`,
      [tenantA.orgId, tenantA.propertyId, conversationA],
    );
    await redactExpiredMessages(client, tenantA, { days: 90, apply: true });
    const after = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM events WHERE property_id = $1",
      [tenantA.propertyId],
    );
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);
  });

  it("does not touch another property's text", async () => {
    const otherId = await message(tenantB, conversationB, "texto que no es de A", OLD);
    await redactExpiredMessages(client, tenantA, { days: 90, apply: true });
    const other = await bodyOf(otherId);
    expect(other.body).toBe("texto que no es de A");
    expect(other.redacted).toBe(false);
  });

  it("honours a narrower window when the property configured one", async () => {
    const id = await message(tenantB, conversationB, "hace cuarenta días", "40 days");
    const narrow = await redactExpiredMessages(client, tenantB, { days: 30, apply: true });
    expect(narrow.count).toBeGreaterThanOrEqual(1);
    expect((await bodyOf(id)).redacted).toBe(true);
  });

  it("0030 refuses an event payload that carries message text", async () => {
    for (const key of ["body", "card", "card_number", "message_text"]) {
      await expect(
        client.query(
          `INSERT INTO events (org_id, property_id, conversation_id, channel, event_type, payload)
           VALUES ($1, $2, $3, 'web', 'message_received', jsonb_build_object($4::text, 'secret'))`,
          [tenantA.orgId, tenantA.propertyId, conversationA, key],
        ),
        key,
      ).rejects.toThrow(/events_payload_no_message_text/);
    }
  });
});
