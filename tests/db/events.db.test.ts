/**
 * S10-01 — event emission, the append-only guarantee, and the reconciliation.
 *
 * D10's promise is that dashboard numbers reconcile exactly to raw events. Three
 * things are asserted here that no other suite asserts:
 *
 *  1. AC-2's seven context fields are present on every row that lands.
 *  2. `events` is append-only at BOTH layers 0029 gives it — the privilege REVOKE
 *     for `concierge_app` (42501) and 0003's trigger for everyone else, including a
 *     superuser (P0001, /append-only/). Testing only the trigger cannot tell you the
 *     grant was ever tightened, and testing only the grant cannot tell you a superuser
 *     is still refused.
 *  3. AC-3's exactness: 100 real production actions produce exactly 100 event rows,
 *     and `reconcile()` reports a zero delta for every metric — plus a case that
 *     proves reconcile CAN fail, because a reconciliation that always passes is a
 *     decoration.
 *
 * The emission-coverage case at the end is a static scan of `src/`, which is unusual
 * and deliberate: AC-1 says the 18 canonical events are "emitted from production
 * paths, not just tests", and the only way to make that executable is to read the
 * production paths. A DB test can only ever prove the events it happened to drive.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emitEvent } from "../../src/events/emit.ts";
import {
  RECONCILE_METRICS,
  describeDrift,
  reconcile,
} from "../../src/events/reconcile.ts";
import { EVENT_NAMES, type EventContext } from "../../src/events/taxonomy.ts";
import { captureRequest, REQUEST_TOPICS } from "../../src/requests/capture.ts";
import { recordGap } from "../../src/gaps/queue.ts";
import type { TenantContext } from "../../src/db/tenant.ts";
import {
  asTenantApp,
  connectScratch,
  dropScratch,
  recreateScratch,
} from "./helpers.db.ts";

let client: pg.Client;

beforeAll(async () => {
  await recreateScratch();
  client = await connectScratch();
}, 120_000);

afterAll(async () => {
  await client?.end();
  await dropScratch();
});

/* ---------- fixtures ----------
 * helpers.db.ts's seedTenant inserts a conversation row directly, and a row
 * inserted by a fixture was never an action: production emits `conversation_started`
 * from guest/service.ts, so a seeded conversation with no event is a reconciliation
 * delta the test would have to explain away. This graph seeds org + property +
 * channel only, and conversations are added by `addConversation`, which emits the
 * event production would have emitted. That is the honest way to make the pair
 * consistent, and it is the same reason src/seed/demo.ts does not reconcile.
 */
interface Graph {
  context: TenantContext;
  channelId: string;
  name: string;
}

let seq = 0;

async function seedGraph(): Promise<Graph> {
  seq += 1;
  const name = `ev${process.pid.toString(36)}${seq}`;
  const org = await client.query<{ org_id: string }>(
    "INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING org_id",
    [`org_${name}`],
  );
  const property = await client.query<{ property_id: string }>(
    "INSERT INTO properties (org_id, name, slug) VALUES ($1, $2, $2) RETURNING property_id",
    [org.rows[0]!.org_id, name],
  );
  const channel = await client.query<{ channel_connection_id: string }>(
    "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web') RETURNING channel_connection_id",
    [org.rows[0]!.org_id, property.rows[0]!.property_id],
  );
  return {
    name,
    channelId: channel.rows[0]!.channel_connection_id,
    context: { orgId: org.rows[0]!.org_id, propertyId: property.rows[0]!.property_id },
  };
}

/**
 * A conversation, plus the event production emits when it is created.
 *
 * `at` exists for the window test, and it is the only way to backdate an event:
 * `events` is append-only, so a row's created_at cannot be updated after the fact.
 * The timestamp is supplied at emission, which is what production does anyway.
 */
async function addConversation(
  graph: Graph,
  at = new Date(),
  eventAt: Date = at,
): Promise<string> {
  const row = await client.query<{ conversation_id: string }>(
    "INSERT INTO conversations (org_id, property_id, connection_id, created_at) VALUES ($1, $2, $3, $4) RETURNING conversation_id",
    [graph.context.orgId, graph.context.propertyId, graph.channelId, at],
  );
  const conversationId = row.rows[0]!.conversation_id;
  await emitEvent(client, graph.context, "conversation_started", ctx(graph, conversationId, eventAt), {
    channel: "web",
    anonymous: true,
  });
  return conversationId;
}

function ctx(graph: Graph, conversationId: string, at = new Date()): EventContext {
  return {
    orgId: graph.context.orgId,
    propertyId: graph.context.propertyId,
    conversationId,
    channel: "web",
    language: "es",
    topic: null,
    createdAt: at.toISOString(),
  };
}

async function countEvents(graph: Graph, type?: string): Promise<number> {
  const q = await client.query<{ n: string }>(
    type === undefined
      ? "SELECT count(*)::text AS n FROM events WHERE org_id = $1 AND property_id = $2"
      : "SELECT count(*)::text AS n FROM events WHERE org_id = $1 AND property_id = $2 AND event_type = $3",
    type === undefined
      ? [graph.context.orgId, graph.context.propertyId]
      : [graph.context.orgId, graph.context.propertyId, type],
  );
  return Number(q.rows[0]!.n);
}

/* ---------- AC-2: the seven context fields ---------- */

describe("S10-01 AC-2 — every event carries its context", () => {
  it("lands all seven fields on every row, for every emittable type", async () => {
    const graph = await seedGraph();
    const conversationId = await addConversation(graph);

    // Sixteen of the eighteen: the two deferred names have no producer, so there is
    // nothing to emit and asserting them here would be asserting a fixture.
    const deferred = new Set(["booking_link_clicked", "outbound_webhook_delivered"]);
    const emittable = EVENT_NAMES.filter((n) => !deferred.has(n));
    expect(emittable).toHaveLength(16);

    for (const type of emittable) {
      await emitEvent(client, graph.context, type, ctx(graph, conversationId), {
        probe: type,
      });
    }

    const rows = await client.query<{
      event_type: string;
      org_id: string;
      property_id: string;
      conversation_id: string;
      channel: string;
      language: string | null;
      topic: string | null;
      created_at: Date;
      payload: unknown;
    }>(
      `SELECT event_type, org_id, property_id, conversation_id, channel, language,
              topic, created_at, payload
         FROM events
        WHERE org_id = $1 AND property_id = $2
        ORDER BY event_id`,
      [graph.context.orgId, graph.context.propertyId],
    );
    // 16 probes + the conversation_started from the fixture.
    expect(rows.rowCount).toBe(17);

    for (const r of rows.rows) {
      // The five that are NOT NULL in 0001 must actually carry a value: a column
      // that exists is not a field that is populated, and a dashboard grouping on a
      // null property_id silently invents a tenth property.
      expect(r.org_id, `${r.event_type}: org_id`).toBe(graph.context.orgId);
      expect(r.property_id, `${r.event_type}: property_id`).toBe(graph.context.propertyId);
      expect(r.conversation_id, `${r.event_type}: conversation_id`).toBe(conversationId);
      expect(r.channel, `${r.event_type}: channel`).toBe("web");
      expect(r.created_at instanceof Date, `${r.event_type}: created_at`).toBe(true);
      // language and topic are nullable BY DESIGN — null means "not detected yet"
      // and "not classified yet". What is not acceptable is a blank topic, which
      // reads as a category in a group-by and is not one.
      expect(r.language === null || r.language.length > 0, `${r.event_type}: language`).toBe(true);
      expect(r.topic === null || r.topic.trim().length > 0, `${r.event_type}: topic`).toBe(true);
      // The key must be PRESENT, not merely non-null: a row missing the column
      // entirely would still pass every check above.
      for (const key of ["org_id", "property_id", "conversation_id", "channel", "language", "topic", "created_at"]) {
        expect(Object.keys(r), `${r.event_type}: has ${key}`).toContain(key);
      }
    }
  });

  it("refuses a payload that is not an object (0029's events_payload_object)", async () => {
    const graph = await seedGraph();
    const conversationId = await addConversation(graph);
    // The writer refuses these before SQL, so the constraint is proven by going
    // around the writer — which is exactly the path the constraint exists for.
    // Valid JSON that is not an object. Note the double quotes on the string case:
    // `'scalar'` is not JSON at all and fails at the ::jsonb cast, which would test
    // the parser rather than the constraint and pass for the wrong reason.
    for (const bad of ['"scalar"', "[1,2]", "null", "3"]) {
      await expect(
        client.query(
          `INSERT INTO events (org_id, property_id, conversation_id, channel, event_type, payload)
           VALUES ($1, $2, $3, 'web', 'conversation_started', $4::jsonb)`,
          [graph.context.orgId, graph.context.propertyId, conversationId, bad],
        ),
        `payload ${bad}`,
      ).rejects.toThrow(/events_payload_object/);
    }
    // An object is accepted, and the default is an object, so the constraint does
    // not merely refuse everything.
    await client.query(
      `INSERT INTO events (org_id, property_id, conversation_id, channel, event_type)
       VALUES ($1, $2, $3, 'web', 'conversation_started')`,
      [graph.context.orgId, graph.context.propertyId, conversationId],
    );
  });
});

/* ---------- append-only at both layers ---------- */

describe("S10-01 — events is append-only at two layers", () => {
  let graph: Graph;
  let eventId: string;

  beforeEach(async () => {
    graph = await seedGraph();
    const conversationId = await addConversation(graph);
    const row = await client.query<{ event_id: string }>(
      "SELECT event_id::text FROM events WHERE org_id = $1 AND property_id = $2 ORDER BY event_id LIMIT 1",
      [graph.context.orgId, graph.context.propertyId],
    );
    eventId = row.rows[0]!.event_id;
    expect(conversationId).toBeTruthy();
  });

  it("denies concierge_app at the PRIVILEGE layer (0029's REVOKE, 42501)", async () => {
    // The privilege check happens before the trigger, so what the app role sees is
    // a permission denial and not the domain exception. That difference is the
    // point: a denial at the grant layer cannot be talked around by a code path
    // that catches the wrong error.
    for (const sql of [
      "UPDATE events SET topic = 'x' WHERE event_id = $1",
      "DELETE FROM events WHERE event_id = $1",
    ]) {
      await asTenantApp(client);
      try {
        const err = await client.query(sql, [eventId]).then(
          () => null,
          (e: unknown) => e as { code?: string; message?: string },
        );
        expect(err, `${sql.slice(0, 6)} should be denied`).not.toBeNull();
        expect(err!.code, sql).toBe("42501");
        expect(err!.message ?? "", sql).toMatch(/permission denied for table events/);
      } finally {
        await client.query("ROLLBACK");
      }
    }
  });

  it("still denies a superuser at the TRIGGER layer (0003, /append-only/)", async () => {
    // A superuser bypasses privileges but not triggers, so this is the layer that
    // protects the table from an operator with a psql session and good intentions.
    await expect(
      client.query("UPDATE events SET topic = 'x' WHERE event_id = $1", [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query("DELETE FROM events WHERE event_id = $1", [eventId]),
    ).rejects.toThrow(/append-only/);
  });

  it("grants concierge_app exactly SELECT and INSERT", async () => {
    const grants = await client.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'events' AND grantee = 'concierge_app'
        ORDER BY privilege_type`,
    );
    expect(grants.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });

  it("has the composite index S10-02's rollups will read through", async () => {
    const idx = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'events_property_type_time'",
    );
    expect(idx.rowCount).toBe(1);
    expect(idx.rows[0]!.indexdef).toMatch(/property_id, event_type, created_at DESC/);
    // 0001's two indexes are deliberately kept: the composite leads with
    // event_type after the tenant, so it cannot serve a property-wide
    // time-ordered scan, and neither can events_type serve a per-property one.
    const all = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'events' ORDER BY indexname",
    );
    expect(all.rows.map((r) => r.indexname).sort()).toEqual([
      "events_pkey",
      "events_property_time",
      "events_property_type_time",
      "events_type",
    ]);
  });
});

/* ---------- AC-3: exactness ---------- */

describe("S10-01 AC-3 — 100 actions produce exactly 100 event rows", () => {
  it("drives 100 requests through the real capture path", async () => {
    const graph = await seedGraph();
    // captureRequest reuses the open request of a conversation, so 100 requests
    // need 100 conversations. Each conversation also emits conversation_started,
    // which is asserted separately rather than left to blur the count.
    const ACTIONS = 100;
    for (let i = 0; i < ACTIONS; i += 1) {
      const conversationId = await addConversation(graph);
      const captured = await captureRequest(client, graph.context, {
        conversationId,
        topic: REQUEST_TOPICS[0]!,
        language: "es",
      });
      expect(captured.created, `action ${i}`).toBe(true);
    }

    const requests = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM service_requests WHERE org_id = $1 AND property_id = $2",
      [graph.context.orgId, graph.context.propertyId],
    );
    expect(Number(requests.rows[0]!.n)).toBe(ACTIONS);
    expect(await countEvents(graph, "request_created")).toBe(ACTIONS);
    expect(await countEvents(graph, "conversation_started")).toBe(ACTIONS);
    // Exactly 200 rows and no more: the assertion that matters is not "at least one
    // event per action" but that no action produced two, and no event appeared for
    // an action that did not happen.
    expect(await countEvents(graph)).toBe(ACTIONS * 2);

    const result = await reconcile(client, graph.context);
    expect(describeDrift(result), describeDrift(result)).toBe(
      "reconciled: every metric delta is zero",
    );
    expect(result.ok).toBe(true);
    expect(result.metrics.map((m) => m.metric)).toEqual([...RECONCILE_METRICS]);
  });

  it("drives 100 distinct gaps through the real gap path", async () => {
    const graph = await seedGraph();
    const conversationId = await addConversation(graph);
    const ACTIONS = 100;
    for (let i = 0; i < ACTIONS; i += 1) {
      // Distinct questions: recordGap dedupes on question_key, so a repeated
      // question increments `hits` and correctly produces no second row or event.
      await recordGap(
        client,
        graph.context,
        { conversationId, question: `¿Pregunta distinta número ${i}?`, language: "es" },
        ctx(graph, conversationId),
        { reasonCode: "no_answer" },
      );
    }
    const gaps = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM knowledge_gaps WHERE org_id = $1 AND property_id = $2",
      [graph.context.orgId, graph.context.propertyId],
    );
    expect(Number(gaps.rows[0]!.n)).toBe(ACTIONS);
    expect(await countEvents(graph, "knowledge_gap_created")).toBe(ACTIONS);

    const result = await reconcile(client, graph.context);
    expect(describeDrift(result)).toBe("reconciled: every metric delta is zero");
  });

  it("produces no second row or event when a gap is repeated", async () => {
    // The dedupe is the reason "100 actions = 100 rows" is not trivially true: a
    // repeated action is not a second action, and counting it as one would inflate
    // every dashboard number built on the gap queue.
    const graph = await seedGraph();
    const conversationId = await addConversation(graph);
    const input = { conversationId, question: "¿Tienen cunas disponibles?", language: "es" as const };
    const first = await recordGap(client, graph.context, input, ctx(graph, conversationId), {
      reasonCode: "no_answer",
    });
    const second = await recordGap(client, graph.context, input, ctx(graph, conversationId), {
      reasonCode: "no_answer",
    });
    expect(second.gapId).toBe(first.gapId);
    expect(await countEvents(graph, "knowledge_gap_created")).toBe(1);
    const result = await reconcile(client, graph.context);
    expect(result.ok, describeDrift(result)).toBe(true);
  });
});

/* ---------- the reconciliation itself ---------- */

describe("S10-01 — reconcile()", () => {
  it("detects a business row that never emitted, which is the whole point", async () => {
    const graph = await seedGraph();
    const conversationId = await addConversation(graph);
    expect((await reconcile(client, graph.context)).ok).toBe(true);

    // A request inserted behind the writer's back: exactly the drift a dashboard
    // cannot see, because the missing event is missing.
    await client.query(
      `INSERT INTO service_requests (org_id, property_id, conversation_id, topic, status)
       VALUES ($1, $2, $3, $4, 'new')`,
      [graph.context.orgId, graph.context.propertyId, conversationId, REQUEST_TOPICS[0]!],
    );
    const after = await reconcile(client, graph.context);
    expect(after.ok).toBe(false);
    expect(after.drifted.map((m) => m.metric)).toEqual(["service_requests"]);
    expect(after.drifted[0]!.delta).toBe(1);
    expect(describeDrift(after)).toMatch(/service_requests: 1 business row vs 0 request_created events \(delta \+1\)/);
  });

  it("counts one tenant only, so a neighbour cannot mask a gap", async () => {
    const a = await seedGraph();
    const b = await seedGraph();
    const convA = await addConversation(a);
    await addConversation(b);
    await captureRequest(client, a.context, {
      conversationId: convA,
      topic: REQUEST_TOPICS[0]!,
      language: "es",
    });

    const ra = await reconcile(client, a.context);
    const rb = await reconcile(client, b.context);
    expect(ra.ok, describeDrift(ra)).toBe(true);
    expect(rb.ok, describeDrift(rb)).toBe(true);
    // Tenant A has the request; tenant B must not see it, and B's own counts must
    // not be padded by A's activity.
    expect(ra.metrics.find((m) => m.metric === "service_requests")!.businessRows).toBe(1);
    expect(rb.metrics.find((m) => m.metric === "service_requests")!.businessRows).toBe(0);
    expect(ra.metrics.find((m) => m.metric === "conversations")!.businessRows).toBe(1);
    expect(rb.metrics.find((m) => m.metric === "conversations")!.businessRows).toBe(1);
  });

  it("honours the window, and rejects an inverted one", async () => {
    const graph = await seedGraph();
    const past = new Date(Date.now() - 60 * 60 * 1000);
    // Both sides of the pair are created with the SAME timestamp, because an event
    // and its business row must move together: backdating only one would make the
    // window test measure the skew between them instead of the window. Updating the
    // event afterwards is not an option — 0003's trigger refuses it, which is
    // asserted above and is the reason `at` is an emission parameter.
    const oldConversation = await addConversation(graph, past);
    expect(oldConversation).toBeTruthy();
    const now = await addConversation(graph);
    expect(now).toBeTruthy();

    const cut = new Date(Date.now() - 30 * 60 * 1000);
    const recent = await reconcile(client, graph.context, { from: cut });
    expect(recent.metrics.find((m) => m.metric === "conversations")!.businessRows).toBe(1);
    expect(recent.ok, describeDrift(recent)).toBe(true);

    const everything = await reconcile(client, graph.context);
    expect(everything.metrics.find((m) => m.metric === "conversations")!.businessRows).toBe(2);
    expect(everything.ok, describeDrift(everything)).toBe(true);

    const none = await reconcile(client, graph.context, { to: cut });
    expect(none.metrics.find((m) => m.metric === "conversations")!.businessRows).toBe(1);
    expect(none.ok, describeDrift(none)).toBe(true);

    await expect(
      reconcile(client, graph.context, { from: new Date(), to: past }),
    ).rejects.toThrow(/earlier than/);
  });

  it("PINS what a window does when two stamps disagree (issue #147, now fixed at source)", async () => {
    // HISTORICAL: this case used to reproduce a live bug. Production no longer does
    // this — every producer now reads its own row's created_at back from the INSERT and
    // stamps the event with it (src/events/clock.ts), so a row and its event carry one
    // identical value and no boundary can fall between them. That is asserted against
    // the real producers in tests/db/clock-agreement.db.test.ts.
    //
    // What remains here is the WINDOW's behaviour, characterised rather than assumed:
    // given two stamps that do disagree, a cut between them excludes the row and
    // includes its event, and the metric reports delta -1 with nothing missing. Keeping
    // it is deliberate. It is the reason the original suite could not see #147 — the
    // case above passes the SAME timestamp to both sides, and a test that constructs
    // agreement cannot detect a disagreement. This one constructs the disagreement on
    // purpose, so if a future producer ever reintroduces a second clock, the shape of
    // the resulting false alarm is already on the record instead of being discovered by
    // whoever is paged by it.
    //
    // The gap is exaggerated to ten seconds to make the boundary deterministic.
    const graph = await seedGraph();
    const businessAt = new Date(Date.now() - 60 * 60 * 1000);
    const eventAt = new Date(businessAt.getTime() + 10 * 1000);
    await addConversation(graph, businessAt, eventAt);

    // Unwindowed: both sides counted, no artifact, no drift.
    const whole = await reconcile(client, graph.context);
    expect(whole.ok, describeDrift(whole)).toBe(true);
    expect(whole.metrics.find((m) => m.metric === "conversations")!.businessRows).toBe(1);

    // A cut between the two clocks. The business row (older) falls outside; its event
    // (newer) falls inside.
    const cut = new Date(businessAt.getTime() + 5 * 1000);
    const skewed = await reconcile(client, graph.context, { from: cut });
    const metric = skewed.metrics.find((m) => m.metric === "conversations")!;
    expect(metric.businessRows).toBe(0);
    expect(metric.events).toBe(1);
    expect(metric.delta).toBe(-1);
    expect(skewed.ok).toBe(false);
    expect(describeDrift(skewed)).toBe(
      "conversations: 0 business rows vs 1 conversation_started event (delta -1)",
    );
    // Every other metric is untouched, so the artifact is confined to the pair that
    // straddles the boundary rather than smearing across the report.
    expect(skewed.drifted.map((m) => m.metric)).toEqual(["conversations"]);
  });
});

/* ---------- AC-1's database half ----------
 * The emission-coverage scan itself lives in tests/events/emission-coverage.test.ts,
 * in the pure suite: it parses source and needs no database, so it should run on
 * every `npm test` rather than only when a Postgres is available. What is asserted
 * here is the half that does need one — that the taxonomy and 0001's CHECK
 * constraint agree, because a name the code emits and the constraint refuses is a
 * failed guest request rather than a lost row.
 */

describe("S10-01 AC-1 — the taxonomy and the database agree", () => {
  it("pins the canonical 18 to 0001's CHECK constraint", async () => {
    // Read the constraint rather than restating the list: a restated list drifts
    // from both the taxonomy and the database, and drifts silently.
    const con = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc FROM pg_constraint
        WHERE conrelid = 'events'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%event_type%'`,
    );
    expect(con.rowCount).toBe(1);
    for (const name of EVENT_NAMES) {
      expect(con.rows[0]!.consrc, `${name} in the events CHECK`).toContain(name);
    }
    expect(EVENT_NAMES).toHaveLength(18);
  });

  it("keeps the two deferred names reserved in the constraint too", async () => {
    // DEC-1: they have no producer, but they stay valid values so DF-01/DF-02 can
    // emit them without a migration. A constraint that had been tightened to the 16
    // would turn that future work into a schema change.
    const con = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc FROM pg_constraint
        WHERE conrelid = 'events'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%event_type%'`,
    );
    for (const name of ["booking_link_clicked", "outbound_webhook_delivered"]) {
      expect(con.rows[0]!.consrc, `${name} still accepted by the CHECK`).toContain(name);
    }
  });
});
