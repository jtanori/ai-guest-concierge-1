/**
 * Issue #147, option 3 — the business row and the event that records it are stamped by
 * ONE clock — plus the `ai_runs` window bug that writing these tests uncovered.
 *
 * `reconcile()` compares a business table against `events` over a window. Before this
 * change the two sides were stamped independently: the row took `created_at` from
 * Postgres (`DEFAULT now()`, the transaction clock) while its event took a JS
 * `new Date()` read elsewhere in the same request. A window boundary falling between
 * those two readings counted the row and not its event, and reported `delta ±1` —
 * indistinguishable from missing instrumentation, which is the one thing a
 * reconciliation must never claim.
 *
 * Option 3 removes the second reading: each producer reads its own row's `created_at`
 * back out of the INSERT and hands that exact value to `emitEvent`.
 *
 * THREE THINGS THIS SUITE IS CAREFUL ABOUT
 *
 * 1. Every timestamp comparison happens IN SQL. Pulling both values into JS and
 *    comparing them there would prove nothing: node-pg parses `timestamptz` into a
 *    `Date`, which holds milliseconds, while Postgres stores microseconds. Both sides
 *    would truncate identically and the assertion would pass with the rows 999us apart —
 *    exactly the residue this change exists to remove. `e.created_at <> b.created_at` in
 *    SQL compares the stored values at full precision.
 *
 * 2. Every assertion also counts how many rows the join MATCHED, and fails if that is
 *    zero. A mismatch count of 0 is what a vacuous test looks like: rename a payload key,
 *    or stop emitting the event, and the join matches nothing while reporting perfect
 *    agreement.
 *
 * 3. The producers are driven for real (`postGuestMessage`, `replyToConversation`,
 *    `assignRequest`, `flagAnswer`, `recordGap`) rather than by inserting a row and an
 *    event by hand. A hand-built pair only ever tests the fixture's own consistency —
 *    which is precisely how the original window test missed this bug, by handing both
 *    sides the same timestamp and so constructing agreement instead of observing it.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { requireRole, type Role } from "../../src/auth/guard.ts";
import type { StaffSession } from "../../src/auth/context.ts";
import { withTenant } from "../../src/db/tenant.ts";
import {
  AI_RUN_TERMINAL_EVENT_TYPES,
  describeDrift,
  reconcile,
} from "../../src/events/reconcile.ts";
import { recordGap } from "../../src/gaps/queue.ts";
import { postGuestMessage, type GuestDeps } from "../../src/guest/service.ts";
import { assignRequest, replyToConversation } from "../../src/inbox/actions.ts";
import { flagAnswer } from "../../src/inbox/flags.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

const SECRET = "c".repeat(40);
const SLUG = "casa-reloj";
const BODY = "La alberca abre a las 07:00 y cierra a las 21:00 todos los días.";

let client: pg.Client;
let orgId: string;
let propertyId: string;
let conversationId: string;
let aiRunId: string;
let runAt: Date;
let flagAt: Date;
let staff: StaffSession;

/** A real bound session: `requireRole` still throws on the wrong surface. */
function sessionFor(userUuid: string, role: Role): StaffSession {
  return { userUuid, role, requireRole: (surface, mode) => requireRole(role, surface, mode) };
}

function ai(output: unknown) {
  return withResilience(
    createFixedProvider(output, "stub-primary-2026-01-01"),
    createFixedProvider(output, "stub-fallback-2026-01-01"),
    { retries: 0, sleep: async () => {}, now: () => 0 },
  );
}

/**
 * `now` is deliberately a LIE, three decades off the real clock. Nothing in a reconciled
 * pair may take a timestamp from it any more. Were any producer still stamping an event
 * from this JS clock, the event would land in 2001 while its business row landed today,
 * and every assertion below would fail loudly rather than quietly disagreeing by a
 * millisecond.
 */
const WRONG_JS_CLOCK = new Date("2001-01-01T00:00:00.000Z");

function deps(output: unknown): GuestDeps {
  return { ai: ai(output), cookieSecret: SECRET, now: () => WRONG_JS_CLOCK };
}

/**
 * A `no_answer` the guardrail accepts. `confidence: null` matters: a numeric confidence
 * on a no-answer is a contract violation, and the guardrail gate returns before the gap
 * is recorded — which is how the first draft of this suite produced zero `knowledge_gaps`
 * rows and a metric-7 case that matched nothing.
 */
const NO_ANSWER = {
  decision: "no_answer",
  answer: null,
  language: "es-MX",
  citations: [],
  reason_code: "low_retrieval",
  topic_keys_used: [],
  confidence: null,
};

beforeAll(async () => {
  await recreateScratch();
  client = await connectScratch();

  const org = await client.query<{ org_id: string }>(
    "INSERT INTO organizations (name, slug) VALUES ('Casa Reloj', 'casa-reloj-org') RETURNING org_id",
  );
  orgId = org.rows[0]!.org_id;
  const property = await client.query<{ property_id: string }>(
    `INSERT INTO properties (org_id, name, slug, time_zone, settings)
     VALUES ($1, 'Hotel Casa Reloj', $2, 'America/Mexico_City', $3::jsonb)
     RETURNING property_id`,
    [orgId, SLUG, JSON.stringify(DEFAULT_SETTINGS)],
  );
  propertyId = property.rows[0]!.property_id;
  await client.query(
    "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web')",
    [orgId, propertyId],
  );

  // A corpus retrieval can hit. Without it the pipeline short-circuits BEFORE the model
  // is called and emits `no_answer_emitted` with no ai_run_id — correct product
  // behaviour, but it would leave metric 8 with nothing to compare.
  await withTenant(client, { orgId, propertyId }, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    const article = await tx.query<{ article_id: string }>(
      `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
       VALUES ($1, $2, 'property', 'pool.hours', 'Alberca', 'es') RETURNING article_id`,
      [orgId, propertyId],
    );
    const version = await tx.query<{ article_version_id: string }>(
      `INSERT INTO article_versions
         (org_id, property_id, article_id, version_no, is_current, body, embedding)
       VALUES ($1, $2, $3, 1, false, $4, $5::vector)
       RETURNING article_version_id`,
      [orgId, propertyId, article.rows[0]!.article_id, BODY, toVectorLiteral(stubEmbedding(BODY))],
    );
    const promoted = version.rows[0]!.article_version_id;
    await tx.query("SELECT promote_article_version($1)", [promoted]);
    await tx.query(
      `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
       VALUES ($1, $2, $3, 0, $4, $5::vector)`,
      [orgId, propertyId, promoted, BODY, toVectorLiteral(stubEmbedding(BODY))],
    );
  });

  // A real staff member: front_desk (role 3) can write the queue surface.
  const userId = await withTenant(client, { orgId, propertyId }, async (tx) => {
    await tx.query("SET LOCAL ROLE concierge_app");
    const u = await tx.query<{ user_id: string }>(
      "SELECT provision_user($1, $2, $3) AS user_id",
      ["auth|clock-desk", "desk@clock.mx", "desk@clock.mx"],
    );
    return u.rows[0]!.user_id;
  });
  await client.query("INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 3)", [
    userId,
    propertyId,
  ]);
  staff = sessionFor(userId, "front_desk");

  // ---- the guest turn: conversation, inbound message, ai_run, request ----
  const turn = await postGuestMessage(deps(NO_ANSWER), client, {
    slug: SLUG,
    text: "alberca abre",
    language: "es",
  });
  conversationId = turn.conversationId;

  const run = await client.query<{ ai_run_id: string; created_at: Date }>(
    "SELECT ai_run_id, created_at FROM ai_runs WHERE property_id = $1 ORDER BY created_at LIMIT 1",
    [propertyId],
  );
  // Fail here rather than in metric 8: an empty ai_runs means the turn never reached the
  // model, and metric 8 would then "pass" on zero rows.
  expect(
    run.rowCount,
    `turn produced no ai_run (decision=${turn.decision} reason=${turn.reasonCode})`,
  ).toBe(1);
  aiRunId = run.rows[0]!.ai_run_id;
  runAt = run.rows[0]!.created_at;

  // ---- the staff actions: reply, assignment, flag ----
  await withTenant(client, { orgId, propertyId }, async (tx) => {
    await tx.query("SELECT set_config('app.current_user_id', $1, true)", [staff.userUuid]);
    await replyToConversation(tx, { orgId, propertyId }, staff, {
      conversationId,
      body: "El desayuno es de 7:00 a 10:30.",
    });
    await assignRequest(tx, { orgId, propertyId }, staff, { conversationId });
  });

  const flagged = await withTenant(client, { orgId, propertyId }, async (tx) => {
    await tx.query("SELECT set_config('app.current_user_id', $1, true)", [staff.userUuid]);
    return flagAnswer(tx, { orgId, propertyId }, staff, { aiRunId, language: "es" });
  });
  expect(flagged.created, "the flag was not created, so metric 6 has nothing to compare").toBe(true);
  const flagRow = await client.query<{ created_at: Date }>(
    "SELECT created_at FROM answer_flags WHERE ai_run_id = $1",
    [aiRunId],
  );
  flagAt = flagRow.rows[0]!.created_at;
}, 120_000);

afterAll(async () => {
  await client?.end();
  await dropScratch();
});

/**
 * Assert a business table and its event agree on `created_at` exactly — and that the
 * assertion actually looked at something.
 */
async function assertOneClock(label: string, sql: string, params: unknown[] = []): Promise<void> {
  const r = await client.query<{ matched: string; mismatched: string; sample: string | null }>(
    sql,
    params,
  );
  const matched = Number(r.rows[0]!.matched);
  const mismatched = Number(r.rows[0]!.mismatched);
  expect(
    matched,
    `${label}: join matched no rows, so the comparison proved nothing`,
  ).toBeGreaterThan(0);
  expect(
    mismatched,
    `${label}: ${mismatched} of ${matched} pairs disagree on created_at (e.g. ${r.rows[0]!.sample})`,
  ).toBe(0);
}

/** Count the pairs, count the disagreements, and show one if there are any. */
function pairSql(join: string, where: string): string {
  return `SELECT count(*) AS matched,
                 count(*) FILTER (WHERE e.created_at <> b.created_at) AS mismatched,
                 min(e.event_type || ': event=' || e.created_at::text || ' row=' || b.created_at::text)
                   FILTER (WHERE e.created_at <> b.created_at) AS sample
            FROM events e JOIN ${join}
           WHERE e.property_id = $1 AND ${where}`;
}

describe("issue #147 option 3 — one clock for the row and its event", () => {
  it("metric 1: conversations ↔ conversation_started", async () => {
    await assertOneClock(
      "conversations",
      pairSql(
        "conversations b ON b.conversation_id = e.conversation_id",
        "e.event_type = 'conversation_started'",
      ),
      [propertyId],
    );
  });

  it("metric 2: guest inbound messages ↔ message_received", async () => {
    // The important one. `messages` is the ONLY reconciled table that does not take
    // `DEFAULT now()`: insertMessage stamps clock_timestamp(), which advances within the
    // transaction, so that the inbound and outbound rows of one turn do not tie and
    // ORDER BY created_at has something to order. This pair therefore cannot agree by
    // sharing a transaction start — the producer has to read the row's own value back,
    // which is why the shortcut of letting events default to now() was rejected.
    await assertOneClock(
      "messages_inbound_guest",
      pairSql(
        "messages b ON b.message_id = (e.payload->>'message_id')::uuid",
        "e.event_type = 'message_received'",
      ),
      [propertyId],
    );
  });

  it("metric 3: staff outbound messages ↔ staff_message_sent", async () => {
    await assertOneClock(
      "messages_outbound_staff",
      pairSql(
        "messages b ON b.message_id = (e.payload->>'message_id')::uuid",
        "e.event_type = 'staff_message_sent'",
      ),
      [propertyId],
    );
  });

  it("metric 4: service_requests ↔ request_created", async () => {
    await assertOneClock(
      "service_requests",
      pairSql(
        "service_requests b ON b.request_id = (e.payload->>'request_id')::uuid",
        "e.event_type = 'request_created'",
      ),
      [propertyId],
    );
  });

  it("metric 5: assignments ↔ request_assigned", async () => {
    // Joined on (request_id, assigned_to) rather than assignment_id: the lifecycle
    // transition path emits without an assignment_id in the payload, and this join
    // covers both writers of `assignments`.
    await assertOneClock(
      "assignments",
      pairSql(
        `assignments b ON b.request_id = (e.payload->>'request_id')::uuid
                       AND b.assigned_to = (e.payload->>'assigned_to')::uuid`,
        "e.event_type = 'request_assigned'",
      ),
      [propertyId],
    );
  });

  it("metric 6: answer_flags ↔ answer_flagged_wrong", async () => {
    await assertOneClock(
      "answer_flags",
      pairSql(
        "answer_flags b ON b.flag_id = (e.payload->>'flag_id')::uuid",
        "e.event_type = 'answer_flagged_wrong'",
      ),
      [propertyId],
    );
  });

  it("metric 7: knowledge_gaps ↔ knowledge_gap_created", async () => {
    // Driven through `recordGap` directly: it is the one production writer of
    // `knowledge_gaps` (both src/ai/answer.ts and src/requests/capture.ts call it), so
    // this exercises the real INSERT...ON CONFLICT and its real emit, including the
    // `(xmax = 0) AS inserted` guard that decides whether an event happens at all.
    await withTenant(client, { orgId, propertyId }, async (tx) => {
      await recordGap(
        tx,
        { orgId, propertyId },
        { conversationId, question: "¿Hay estacionamiento?", language: "es", topic: null },
        {
          orgId,
          propertyId,
          conversationId,
          channel: "web",
          language: "es",
          topic: null,
        },
        { reasonCode: "low_retrieval" },
      );
    });
    await assertOneClock(
      "knowledge_gaps",
      pairSql(
        "knowledge_gaps b ON b.gap_id = (e.payload->>'gap_id')::uuid",
        "e.event_type = 'knowledge_gap_created'",
      ),
      [propertyId],
    );
  });

  it("metric 8: ai_runs ↔ the events emitted with the run", async () => {
    // Scoped to AI_RUN_TERMINAL_EVENT_TYPES exactly as the metric is. Counting every
    // event that merely NAMES a run would include `answer_flagged_wrong`, which is
    // written when a person reviews the answer and is correctly stamped from the
    // answer_flags row — a different moment, and the subject of the case below.
    const types = AI_RUN_TERMINAL_EVENT_TYPES.map((t) => `'${t}'`).join(", ");
    await assertOneClock(
      "ai_runs",
      pairSql(
        "ai_runs b ON b.ai_run_id = (e.payload->>'ai_run_id')::uuid",
        `e.payload ? 'ai_run_id' AND e.event_type IN (${types})`,
      ),
      [propertyId],
    );
  });

  it("no reconciled event carries the injected JS clock", async () => {
    // The blunt version of the same claim, and the one that would catch a producer this
    // suite forgot to drive: nothing in `events` for this property may bear the
    // timestamp `deps.now` handed out.
    const r = await client.query<{ n: string; types: string | null }>(
      `SELECT count(*) AS n, min(event_type) AS types
         FROM events
        WHERE property_id = $1 AND created_at = $2::timestamptz`,
      [propertyId, WRONG_JS_CLOCK.toISOString()],
    );
    expect(Number(r.rows[0]!.n), `events stamped from the JS clock: ${r.rows[0]!.types}`).toBe(0);
  });

  it("the stamps really do carry sub-millisecond precision", async () => {
    // Without this, every assertion above could pass on values truncated to
    // milliseconds — the suite would be comparing coarser data than Postgres stores, and
    // a 999us disagreement would look like agreement.
    const r = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT created_at FROM messages WHERE property_id = $1
         UNION ALL SELECT created_at FROM conversations WHERE property_id = $1
         UNION ALL SELECT created_at FROM events WHERE property_id = $1
       ) x
       WHERE (date_part('microseconds', x.created_at))::bigint % 1000 <> 0`,
      [propertyId],
    );
    expect(Number(r.rows[0]!.n)).toBeGreaterThan(0);
  });
});

describe("the ai_runs window bug these tests uncovered", () => {
  it("a flag written after the run does not make the run's metric drift", async () => {
    // `answer_flagged_wrong` names an ai_run but is stamped from the answer_flags row,
    // which is correct — a flag is a fact about the moment someone reviewed the answer,
    // not about the moment the model ran. Counting it on the event side of the `ai_runs`
    // metric made a window that contained the flag but not the run report one distinct
    // run against zero rows: phantom drift on a database with nothing missing.
    //
    // The window starts exactly at the flag, so the run (earlier) is outside it.
    expect(flagAt.getTime()).toBeGreaterThan(runAt.getTime());
    const result = await reconcile(client, { orgId, propertyId }, { from: flagAt });
    const metric = result.metrics.find((m) => m.metric === "ai_runs")!;
    expect(
      metric.delta,
      `ai_runs drifted in a window holding the flag but not the run: ${describeDrift(result)}`,
    ).toBe(0);
    expect(metric.businessRows).toBe(0);
    expect(metric.events).toBe(0);
  });

  it("no unexpected event type carries ai_run_id", async () => {
    // Drift guard for the filter above. A new event type that names a run is either
    // run-terminal (and belongs in AI_RUN_TERMINAL_EVENT_TYPES, or the metric silently
    // under-counts) or a later action like the flag (and must stay out, or the metric
    // silently over-counts). Either way it needs a decision, not a default.
    const r = await client.query<{ event_type: string }>(
      `SELECT DISTINCT event_type FROM events
        WHERE property_id = $1 AND payload ? 'ai_run_id'
        ORDER BY event_type`,
      [propertyId],
    );
    const allowed: readonly string[] = [...AI_RUN_TERMINAL_EVENT_TYPES, "answer_flagged_wrong"];
    const unexpected = r.rows.map((row) => row.event_type).filter((t) => !allowed.includes(t));
    expect(
      unexpected,
      `event types carrying ai_run_id that reconcile.ts has not classified: ${unexpected.join(", ")}`,
    ).toEqual([]);
    // And the suite must actually have exercised both classes, or the guard is vacuous.
    const seen = r.rows.map((row) => row.event_type);
    expect(seen).toContain("answer_flagged_wrong");
    expect(seen.some((t) => (AI_RUN_TERMINAL_EVENT_TYPES as readonly string[]).includes(t))).toBe(true);
  });
});
