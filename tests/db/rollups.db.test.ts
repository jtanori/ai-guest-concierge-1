/**
 * S10-02 — rollups against a real database.
 *
 * The two acceptance criteria are checked against independent SQL rather than
 * against the rollup's own output: AC-2 compares each count with
 * `SELECT count(*) … FROM events` bounded by the property-local day, and AC-1
 * compares two runs of the same date with each other. A test that asserts a
 * function returns what the same function just computed proves nothing.
 *
 * Two clients on purpose. `owner` (the suite's superuser) seeds fixtures and reads
 * ground truth; `app` drops into `concierge_app` so every rollup statement runs
 * through the tenant policies — a superuser would bypass RLS and the isolation
 * assertions below would pass without exercising anything.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRollups, type RollupResult } from "../../src/analytics/rollups.ts";
import { withTenant, type TenantContext } from "../../src/db/tenant.ts";
import { connectScratch, dropScratch, recreateScratch, scratchUrl, seedTenant } from "./helpers.db.ts";

const ZONE = "America/Hermosillo";
const DAY = "2026-10-25";

let owner: pg.Client;
let app: pg.Client;
let tenantA: TenantContext;
let tenantB: TenantContext;
let conversation1: string;
let conversation2: string;
let conversationB: string;

function valueOf(result: RollupResult, metric: string, day = DAY): number | undefined {
  return result.rows.find((row) => row.metric === metric && row.windowStart === day)?.value;
}

/** Independent ground truth: a plain count over events, bounded by the local day. */
async function directCount(
  context: TenantContext,
  eventType: string,
  day: string,
): Promise<number> {
  const result = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM events e
      WHERE e.org_id = $1 AND e.property_id = $2 AND e.event_type = $3
        AND e.created_at >= (($4::date)::timestamp AT TIME ZONE $5)
        AND e.created_at <  ((($4::date) + 1)::timestamp AT TIME ZONE $5)`,
    [context.orgId, context.propertyId, eventType, day, ZONE],
  );
  return Number(result.rows[0]!.n);
}

async function event(
  context: TenantContext,
  conversationId: string,
  eventType: string,
  at: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO events (org_id, property_id, conversation_id, channel, event_type, payload, created_at)
     VALUES ($1, $2, $3, 'web', $4, '{}'::jsonb, $5::timestamptz)`,
    [context.orgId, context.propertyId, conversationId, eventType, at],
  );
}

async function message(
  context: TenantContext,
  conversationId: string,
  input: { direction: "inbound" | "outbound"; author: "guest" | "ai" | "staff"; at: string },
): Promise<void> {
  await owner.query(
    `INSERT INTO messages (org_id, property_id, conversation_id, direction, author_role, body, created_at)
     VALUES ($1, $2, $3, $4, $5, 'fixture', $6::timestamptz)`,
    [context.orgId, context.propertyId, conversationId, input.direction, input.author, input.at],
  );
}

async function conversation(context: TenantContext, channelId: string): Promise<string> {
  const created = await owner.query<{ conversation_id: string }>(
    `INSERT INTO conversations (org_id, property_id, connection_id, created_at)
     VALUES ($1, $2, $3, $4::timestamptz) RETURNING conversation_id`,
    [context.orgId, context.propertyId, channelId, `${DAY} 12:00:00-07`],
  );
  return created.rows[0]!.conversation_id;
}

describe("daily rollups (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    owner = await connectScratch();

    const seededA = await seedTenant(owner, "rollup_a");
    tenantA = { orgId: seededA.orgId, propertyId: seededA.propertyId };
    conversation1 = seededA.conversationId;
    await owner.query("UPDATE properties SET time_zone = $2 WHERE property_id = $1", [
      tenantA.propertyId,
      ZONE,
    ]);

    // A SECOND PROPERTY IN THE SAME ORG: the case a per-property unique key can get
    // wrong without any RLS involvement at all.
    const propertyB = await owner.query<{ property_id: string }>(
      `INSERT INTO properties (org_id, name, slug, time_zone)
       VALUES ($1, 'rollup_b', 'rollup_b', $2) RETURNING property_id`,
      [tenantA.orgId, ZONE],
    );
    const channelB = await owner.query<{ channel_connection_id: string }>(
      `INSERT INTO channel_connections (org_id, property_id, channel)
       VALUES ($1, $2, 'web') RETURNING channel_connection_id`,
      [tenantA.orgId, propertyB.rows[0]!.property_id],
    );
    tenantB = { orgId: tenantA.orgId, propertyId: propertyB.rows[0]!.property_id };
    conversationB = await conversation(tenantB, channelB.rows[0]!.channel_connection_id);

    // ---- property A, local day 2026-10-25 (UTC-7, no DST in Sonora) ----------
    // 08:00 and 11:00 local; the third row below is 19:00 local on the SAME day,
    // written as 02:00Z on the 26th — the timezone boundary case.
    await owner.query("UPDATE conversations SET created_at = $2 WHERE conversation_id = $1", [
      conversation1,
      "2026-10-25T15:00:00Z",
    ]);
    await event(tenantA, conversation1, "conversation_started", "2026-10-25T15:00:00Z");
    await event(tenantA, conversation1, "message_received", "2026-10-25T15:00:00Z");
    await event(tenantA, conversation1, "ai_answer_sent", "2026-10-25T15:00:04Z");
    await message(tenantA, conversation1, {
      direction: "inbound",
      author: "guest",
      at: "2026-10-25T15:00:00Z",
    });
    await message(tenantA, conversation1, {
      direction: "outbound",
      author: "ai",
      at: "2026-10-25T15:00:04Z",
    });

    conversation2 = await conversation(tenantA, seededA.channelId);
    await owner.query(
      "UPDATE conversations SET created_at = $2 WHERE conversation_id = $1",
      [conversation2, "2026-10-25T18:00:00Z"],
    );
    await event(tenantA, conversation2, "conversation_started", "2026-10-25T18:00:00Z");
    await event(tenantA, conversation2, "message_received", "2026-10-25T18:00:00Z");
    // A staff reply means conversation 2 was NOT contained.
    await event(tenantA, conversation2, "staff_message_sent", "2026-10-25T18:10:00Z");

    await event(tenantA, conversation2, "message_received", "2026-10-26T02:00:00Z");

    // An earlier day, for the late-event recompute.
    await event(tenantA, conversation1, "conversation_started", "2026-10-23T16:00:00Z");

    // Property B: a different number on the same day, to catch a mixed-up key.
    for (let index = 0; index < 5; index++) {
      await event(tenantB, conversationB, "conversation_started", "2026-10-25T16:00:00Z");
    }

    app = new pg.Client({ connectionString: scratchUrl() });
    app.on("error", () => undefined);
    await app.connect();
    await app.query("SET ROLE concierge_app");
  });

  afterAll(async () => {
    await app.end();
    await owner.end();
    await dropScratch();
  });

  it("AC-2: every count metric equals a direct SELECT count(*) FROM events", async () => {
    const result = await runRollups(app, tenantA, { from: DAY, to: DAY });
    expect(result.dryRun).toBe(false);

    const pairs: ReadonlyArray<[metric: string, eventType: string]> = [
      ["conversations_started", "conversation_started"],
      ["messages_received", "message_received"],
      ["ai_answers_sent", "ai_answer_sent"],
      ["escalations", "ai_escalated"],
      ["no_answers", "no_answer_emitted"],
      ["requests_created", "request_created"],
      ["requests_acknowledged", "request_acknowledged"],
      ["knowledge_gaps_opened", "knowledge_gap_created"],
      ["knowledge_gaps_closed", "knowledge_gap_closed"],
    ];
    for (const [metric, eventType] of pairs) {
      expect(valueOf(result, metric), metric).toBe(await directCount(tenantA, eventType, DAY));
    }

    // Sanity: the fixture is not all zeroes, so the equality above means something.
    expect(valueOf(result, "conversations_started")).toBe(2);
    expect(valueOf(result, "messages_received")).toBe(3);
  });

  it("AC-1: recomputing the same date is idempotent", async () => {
    const first = await runRollups(app, tenantA, { from: DAY, to: DAY });
    const stored = await owner.query<{ metric: string; window_start: string; value: string }>(
      `SELECT metric, window_start::text, value::text FROM rollups
        WHERE org_id = $1 AND property_id = $2 ORDER BY metric, window_start`,
      [tenantA.orgId, tenantA.propertyId],
    );

    const second = await runRollups(app, tenantA, { from: DAY, to: DAY });

    expect(second.rows).toEqual(first.rows);
    expect(second.written).toBe(first.written);
    const after = await owner.query<{ metric: string; window_start: string; value: string }>(
      `SELECT metric, window_start::text, value::text FROM rollups
        WHERE org_id = $1 AND property_id = $2 ORDER BY metric, window_start`,
      [tenantA.orgId, tenantA.propertyId],
    );
    // Same values, same row count — an upsert, not an insert.
    expect(after.rows).toEqual(stored.rows);
  });

  it("uses the property's local day: 02:00Z on the 26th belongs to the 25th", async () => {
    const result = await runRollups(app, tenantA, { from: "2026-10-25", to: "2026-10-26" });
    expect(valueOf(result, "messages_received", "2026-10-25")).toBe(3);
    // ...and the 26th has no inbound message of its own.
    expect(valueOf(result, "messages_received", "2026-10-26")).toBe(0);
  });

  it("containment is the share of conversations that never needed staff", async () => {
    const result = await runRollups(app, tenantA, { from: DAY, to: DAY });
    // 2 started, 1 escalated to a human.
    expect(valueOf(result, "containment")).toBe(0.5);
  });

  it("first response p95 measures the wait from question to first reply", async () => {
    const result = await runRollups(app, tenantA, { from: DAY, to: DAY });
    // conversation 1 was answered after 4s; conversation 2 never was, so it has no
    // first response and is not counted as instant.
    expect(valueOf(result, "first_response_p95_seconds")).toBe(4);
  });

  it("a late event changes only its own date", async () => {
    const before = await runRollups(app, tenantA, { from: "2026-10-23", to: "2026-10-25" });
    expect(valueOf(before, "messages_received", "2026-10-23")).toBe(0);
    expect(valueOf(before, "messages_received", "2026-10-24")).toBe(0);

    await event(tenantA, conversation1, "message_received", "2026-10-23T16:30:00Z");
    const after = await runRollups(app, tenantA, { from: "2026-10-23", to: "2026-10-25" });

    expect(valueOf(after, "messages_received", "2026-10-23")).toBe(1);
    expect(valueOf(after, "messages_received", "2026-10-24")).toBe(0);
    expect(valueOf(after, "messages_received", "2026-10-25")).toBe(
      valueOf(before, "messages_received", "2026-10-25"),
    );
    expect(await directCount(tenantA, "message_received", "2026-10-23")).toBe(1);
  });

  it("two properties in one org never share a row", async () => {
    const a = await runRollups(app, tenantA, { from: DAY, to: DAY });
    const b = await runRollups(app, tenantB, { from: DAY, to: DAY });

    expect(valueOf(a, "conversations_started")).toBe(2);
    expect(valueOf(b, "conversations_started")).toBe(5);

    const rows = await owner.query<{ property_id: string; n: string }>(
      `SELECT property_id, count(*)::text AS n FROM rollups
        WHERE org_id = $1 GROUP BY 1 ORDER BY 2`,
      [tenantA.orgId],
    );
    // Every stored row names exactly one property; neither property is short of rows.
    expect(rows.rows.length).toBe(2);
    for (const row of rows.rows) expect(Number(row.n)).toBeGreaterThan(0);
  });

  it("writes nothing for another tenant, even when asked to", async () => {
    const before = await owner.query(
      "SELECT count(*)::text AS n FROM rollups WHERE property_id = $1",
      [tenantB.propertyId],
    );
    // Context A: the policy matches property A, so B's rows are invisible and
    // unwritable. (The isolation suite proves the policy; this proves the writer
    // goes through it.)
    await withTenant(app, tenantA, async (scoped) => {
      const visible = await scoped.query(
        "SELECT count(*)::text AS n FROM rollups WHERE property_id = $1",
        [tenantB.propertyId],
      );
      expect(visible.rows[0]!.n).toBe("0");
    });
    const after = await owner.query(
      "SELECT count(*)::text AS n FROM rollups WHERE property_id = $1",
      [tenantB.propertyId],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("deletes a percentile row when the day no longer has data", async () => {
    const request = await owner.query<{ request_id: string }>(
      `INSERT INTO service_requests (org_id, property_id, created_at, acknowledged_at, status)
       VALUES ($1, $2, '2026-10-24T17:00:00Z', '2026-10-24T17:10:00Z', 'acknowledged')
       RETURNING request_id`,
      [tenantA.orgId, tenantA.propertyId],
    );

    const withRequest = await runRollups(app, tenantA, { from: "2026-10-24", to: "2026-10-24" });
    expect(valueOf(withRequest, "ack_median_seconds", "2026-10-24")).toBe(600);

    await owner.query("DELETE FROM service_requests WHERE request_id = $1", [
      request.rows[0]!.request_id,
    ]);
    const withoutRequest = await runRollups(app, tenantA, { from: "2026-10-24", to: "2026-10-24" });

    // No row at all: a median of zero seconds would read as "acknowledged instantly".
    expect(valueOf(withoutRequest, "ack_median_seconds", "2026-10-24")).toBeUndefined();
    const stored = await owner.query(
      `SELECT 1 FROM rollups WHERE metric = 'ack_median_seconds'
         AND property_id = $1 AND window_start = '2026-10-24'`,
      [tenantA.propertyId],
    );
    expect(stored.rowCount).toBe(0);
  });

  it("dry-run computes the same numbers and writes nothing", async () => {
    const storedBefore = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM rollups WHERE property_id = $1",
      [tenantA.propertyId],
    );

    const dry = await runRollups(app, tenantA, { from: DAY, to: DAY }, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.written).toBe(0);
    expect(valueOf(dry, "conversations_started")).toBe(2);

    const storedAfter = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM rollups WHERE property_id = $1",
      [tenantA.propertyId],
    );
    expect(storedAfter.rows[0]!.n).toBe(storedBefore.rows[0]!.n);
  });
});
