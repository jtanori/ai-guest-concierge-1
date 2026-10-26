/**
 * S09-04 — review work that cannot delay a guest.
 *
 * AC-1: the outbound guest message is committed before any review work starts.
 * AC-2: review work is retried from the outbox on failure, and a failure never
 * re-sends the guest message.
 *
 * The interesting assertions are therefore about *ordering* and about *absence*:
 * the reply exists before anything reads the queue, and a worker that fails — and
 * then retries, and then replays — leaves exactly one outbound message every time.
 * "Never re-sends" is structural (the worker holds no provider and no channel
 * adapter), but a structural guarantee is worth a counting test, because the count
 * is what a guest would notice.
 *
 * Failure is injected by revoking the one privilege the work needs, which makes the
 * worker fail for a real database reason (42501) rather than because a stub was
 * told to throw. Granting it back is the recovery, so the retry case is the same
 * code path a deploy would take.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { postGuestMessage, type GuestDeps } from "../../src/guest/service.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { toVectorLiteral } from "../../src/knowledge/embedding.ts";
import { stubEmbedding } from "../../src/seed/embedding.ts";
import {
  enqueueReview,
  processReviewOutbox,
  reviewBackoffMs,
  REVIEW_MAX_ATTEMPTS,
} from "../../src/review/queue.ts";
import { connectScratch, dropScratch, recreateScratch, scratchUrl } from "./helpers.db.ts";

const SECRET = "g".repeat(40);
// Hyphenated: SLUG_RE in src/guest/session.ts rejects an underscore, and a
// malformed slug is a 404 before any tenant work happens.
const SLUG_A = "review-a";
const SLUG_B = "review-b";
const BODY = "La alberca abre a las 07:00 y cierra a las 21:00 todos los días.";

let client: pg.Client;
let pool: pg.Pool;
let tenantA: { orgId: string; propertyId: string };
let tenantB: { orgId: string; propertyId: string };
let conversationId = "";

/**
 * The conversation the first turn actually answered.
 *
 * Not the one `seedProperty` created: `postGuestMessage` is called without a
 * ticket, so every turn opens a fresh conversation, and counting outbound messages
 * on the seeded one counts nothing. AC-2's whole claim is "the reply is still
 * exactly one", so it has to be counted on the conversation that has a reply.
 */
let answeredConversation = "";
/** Per property: a turn that cites another property's version does not answer. */
const versionBySlug = new Map<string, string>();

/**
 * A property the guest path will actually serve.
 *
 * Not `seedTenant`: that helper leaves `settings` at its `'{}'` default, and the
 * guest session parses settings before it will answer, so a property seeded that
 * way surfaces as `UnknownPropertyError` — a confusing way to fail a test about
 * the review queue.
 */
async function seedProperty(slug: string) {
  const org = await client.query<{ org_id: string }>(
    "INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING org_id",
    [`org_${slug}`],
  );
  const property = await client.query<{ property_id: string }>(
    `INSERT INTO properties (org_id, name, slug, time_zone, settings)
     VALUES ($1, $2, $2, 'America/Mexico_City', $3::jsonb) RETURNING property_id`,
    [org.rows[0]!.org_id, slug, JSON.stringify(DEFAULT_SETTINGS)],
  );
  const channel = await client.query<{ channel_connection_id: string }>(
    "INSERT INTO channel_connections (org_id, property_id, channel) VALUES ($1, $2, 'web') RETURNING channel_connection_id",
    [org.rows[0]!.org_id, property.rows[0]!.property_id],
  );
  const conversation = await client.query<{ conversation_id: string }>(
    "INSERT INTO conversations (org_id, property_id, connection_id) VALUES ($1, $2, $3) RETURNING conversation_id",
    [org.rows[0]!.org_id, property.rows[0]!.property_id, channel.rows[0]!.channel_connection_id],
  );
  return {
    orgId: org.rows[0]!.org_id,
    propertyId: property.rows[0]!.property_id,
    conversationId: conversation.rows[0]!.conversation_id,
  };
}

function guestDeps(slug: string): GuestDeps {
  const versionId = versionBySlug.get(slug);
  if (versionId === undefined) throw new Error(`no article seeded for slug ${slug}`);
  const output = {
    decision: "answer",
    answer: "La alberca abre a las 07:00 y cierra a las 21:00.",
    language: "es-MX",
    citations: [{ article_version_id: versionId, quote: "abre a las 07:00" }],
    reason_code: null,
    topic_keys_used: ["pool.hours"],
    confidence: 0.9,
  };
  return {
    ai: withResilience(
      createFixedProvider(output, "stub-review-primary-2026-01-01"),
      createFixedProvider(output, "stub-review-fallback-2026-01-01"),
      { retries: 0, sleep: async () => {}, now: () => 0 },
    ),
    cookieSecret: SECRET,
    embed: async (text: string) => stubEmbedding(text),
    now: () => new Date("2026-10-26T16:00:00Z"),
  };
}

/** One article the model can cite, so the turn is an `answer` with a run behind it. */
async function seedArticle(tenant: { orgId: string; propertyId: string }): Promise<string> {
  const created = await client.query<{ article_id: string }>(
    `INSERT INTO knowledge_articles (org_id, property_id, scope, topic_key, title, language)
     VALUES ($1, $2, 'property', 'pool.hours', 'Alberca', 'es') RETURNING article_id`,
    [tenant.orgId, tenant.propertyId],
  );
  const version = await client.query<{ article_version_id: string }>(
    `INSERT INTO article_versions
       (org_id, property_id, article_id, version_no, is_current, body, embedding)
     VALUES ($1, $2, $3, 1, false, $4, $5::vector) RETURNING article_version_id`,
    [tenant.orgId, tenant.propertyId, created.rows[0]!.article_id, BODY, toVectorLiteral(stubEmbedding(BODY))],
  );
  await client.query("SELECT promote_article_version($1)", [version.rows[0]!.article_version_id]);
  await client.query(
    `INSERT INTO article_chunks (org_id, property_id, article_version_id, ordinal, body, embedding)
     VALUES ($1, $2, $3, 0, $4, $5::vector)`,
    [tenant.orgId, tenant.propertyId, version.rows[0]!.article_version_id, BODY, toVectorLiteral(stubEmbedding(BODY))],
  );
  return version.rows[0]!.article_version_id;
}

async function outboundCount(conversation: string): Promise<number> {
  const rows = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages
      WHERE conversation_id = $1 AND direction = 'outbound'`,
    [conversation],
  );
  return Number(rows.rows[0]!.n);
}

interface OutboxRow {
  outbox_id: string;
  kind: string;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  processed_at: Date | null;
  payload: Record<string, unknown>;
}

async function reviewRows(): Promise<OutboxRow[]> {
  const rows = await client.query<OutboxRow>(
    `SELECT outbox_id::text, kind, status, attempts, next_attempt_at, last_error, processed_at, payload
       FROM outbox WHERE kind = 'review' ORDER BY outbox_id`,
  );
  return rows.rows;
}

/** One real guest turn, which is the only honest way to produce an answer + a run. */
async function ask(text = "¿A qué hora abre la alberca?", slug = SLUG_A) {
  return postGuestMessage(guestDeps(slug), client, { slug, text, language: "es" });
}

describe("review queue (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    // The worker needs a pool: it checks a client out per row.
    pool = new pg.Pool({ connectionString: scratchUrl(), max: 4 });

    const a = await seedProperty(SLUG_A);
    tenantA = { orgId: a.orgId, propertyId: a.propertyId };
    conversationId = a.conversationId;
    const b = await seedProperty(SLUG_B);
    tenantB = { orgId: b.orgId, propertyId: b.propertyId };

    // Seeded as superuser: promote_article_version reads the tenant GUCs (0003),
    // so it runs inside a tenant transaction of its own.
    for (const tenant of [tenantA, tenantB]) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenant.orgId]);
      await client.query("SELECT set_config('app.current_property_id', $1, true)", [tenant.propertyId]);
      const id = await seedArticle(tenant);
      await client.query("COMMIT");
      versionBySlug.set(tenant === tenantA ? SLUG_A : SLUG_B, id);
    }
  });

  afterAll(async () => {
    await pool.end();
    await client.end();
    await dropScratch();
  });

  describe("AC-1 — the reply is committed before any review work starts", () => {
    it("writes the guest message and the queued review in one commit", async () => {
      const turn = await ask();
      expect(turn.decision).toBe("answer");
      answeredConversation = turn.conversationId;

      // Both are visible from a session that was not part of the turn, which is
      // what "committed" means: had the review work happened inside the turn, the
      // outbox row would already be `sent`.
      expect(await outboundCount(turn.conversationId)).toBe(1);
      const rows = await reviewRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "review", status: "pending", attempts: 0 });
      expect(rows[0]!.payload).toMatchObject({ conversation_id: turn.conversationId });
      expect(typeof rows[0]!.payload["ai_run_id"]).toBe("string");
      // Nothing has processed it: the reply went out first, and the review work is
      // still waiting for somebody to claim it.
      expect(rows[0]!.processed_at).toBeNull();
      const dispositions = await client.query("SELECT 1 FROM answer_reviews");
      expect(dispositions.rowCount).toBe(0);
    });

    it("takes the queued row with the reply when the transaction rolls back", async () => {
      // The other half of sharing a commit: review work must not survive a reply
      // that did not.
      const before = (await reviewRows()).length;
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE concierge_app");
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenantA.orgId]);
        await client.query("SELECT set_config('app.current_property_id', $1, true)", [tenantA.propertyId]);
        const run = await client.query<{ ai_run_id: string }>(
          "SELECT ai_run_id FROM ai_runs WHERE property_id = $1 LIMIT 1",
          [tenantA.propertyId],
        );
        await enqueueReview(client, tenantA, {
          aiRunId: run.rows[0]!.ai_run_id,
          conversationId,
        });
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      expect(await reviewRows()).toHaveLength(before);
    });

    it("cannot queue the same answer twice, and does not raise trying", async () => {
      // Inside the guest's transaction, so an error here would roll the reply back —
      // the opposite of AC-1. ON CONFLICT DO NOTHING is what makes that impossible.
      const rows = await reviewRows();
      const aiRunId = String(rows[0]!.payload["ai_run_id"]);
      const second = await enqueueReview(client, tenantA, { aiRunId, conversationId });
      expect(second).toMatchObject({ enqueued: false, outboxId: null });
      expect((await reviewRows()).filter((r) => r.payload["ai_run_id"] === aiRunId)).toHaveLength(1);
    });
  });

  describe("AC-2 — retried from the outbox, and never re-sending the reply", () => {
    it("a failing worker leaves the reply intact and the row pending its retry", async () => {
      const messagesBefore = await outboundCount(answeredConversation);

      // Revoke the one privilege the work needs. The worker now fails for a real
      // database reason rather than because a stub was told to throw.
      await client.query("REVOKE INSERT ON answer_reviews FROM concierge_app");
      const tally = await processReviewOutbox(pool);
      await client.query("GRANT SELECT, INSERT, UPDATE ON answer_reviews TO concierge_app");

      expect(tally).toMatchObject({ claimed: 1, completed: 0, failed: 1, dead: 0 });

      // The reply is untouched: this is the assertion the AC is actually about.
      expect(await outboundCount(answeredConversation)).toBe(messagesBefore);
      expect(messagesBefore).toBe(1);

      const rows = await reviewRows();
      expect(rows[0]).toMatchObject({ status: "failed", attempts: 1, processed_at: null });
      expect(rows[0]!.last_error).not.toBeNull();
      expect(String(rows[0]!.last_error)).toMatch(/permission denied/);
      // Due later, not immediately. How much later is asserted by the next case,
      // which is that the worker declines to claim it — behaviour rather than a
      // clock window that would flake on a slow machine.
      expect(rows[0]!.next_attempt_at).not.toBeNull();
      expect(reviewBackoffMs(1)).toBe(1000);
      // And no disposition was written half-way.
      const dispositions = await client.query("SELECT 1 FROM answer_reviews");
      expect(dispositions.rowCount).toBe(0);
    });

    it("does not claim a row whose retry is not due yet", async () => {
      // Backoff that a claim ignores is not backoff. The row above is due in ~1s.
      const tally = await processReviewOutbox(pool);
      expect(tally).toMatchObject({ claimed: 0, completed: 0, failed: 0, dead: 0 });
      expect((await reviewRows())[0]!.attempts).toBe(1);
      expect(await outboundCount(answeredConversation)).toBe(1);
    });

    it("retries from the outbox once the row is due, and still sends nothing twice", async () => {
      await client.query("UPDATE outbox SET next_attempt_at = now() WHERE kind = 'review'");
      const tally = await processReviewOutbox(pool);
      expect(tally).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

      const rows = await reviewRows();
      expect(rows[0]).toMatchObject({ status: "sent", attempts: 2 });
      expect(rows[0]!.processed_at).not.toBeNull();
      expect(rows[0]!.last_error).toBeNull();

      // The whole point: a retry that recovered the review work did NOT recover the
      // guest message by sending it again.
      expect(await outboundCount(answeredConversation)).toBe(1);

      const dispositions = await client.query<{ needs_review: boolean; reason: string }>(
        "SELECT needs_review, reason FROM answer_reviews",
      );
      expect(dispositions.rowCount).toBe(1);
      expect(dispositions.rows[0]).toMatchObject({ needs_review: false, reason: "answered" });
    });

    it("a replay of a sent row writes no second disposition", async () => {
      // Force the row claimable again to prove idempotency is a property of the
      // work, not of the outbox status.
      await client.query("UPDATE outbox SET status = 'pending', next_attempt_at = NULL WHERE kind = 'review'");
      const tally = await processReviewOutbox(pool);
      expect(tally).toMatchObject({ claimed: 1, completed: 1 });

      const dispositions = await client.query("SELECT 1 FROM answer_reviews");
      expect(dispositions.rowCount).toBe(1);
      expect(await outboundCount(answeredConversation)).toBe(1);
    });

    it("gives up after the attempt limit, and says why on the row", async () => {
      // The replay case above left this row `sent`, and a sent row is not
      // claimable. Put it back to a fresh pending row so there is something to
      // exhaust — this is the state a first delivery would be in.
      await client.query(
        `UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = NULL,
                 processed_at = NULL, last_error = NULL WHERE kind = 'review'`,
      );
      await client.query("DELETE FROM answer_reviews");
      await client.query("REVOKE INSERT ON answer_reviews FROM concierge_app");
      let lastTally = { claimed: 0, completed: 0, failed: 0, dead: 0 };
      for (let attempt = 0; attempt < REVIEW_MAX_ATTEMPTS + 2; attempt += 1) {
        await client.query("UPDATE outbox SET next_attempt_at = NULL WHERE kind = 'review'");
        lastTally = await processReviewOutbox(pool);
        if (lastTally.dead > 0) break;
      }
      await client.query("GRANT SELECT, INSERT, UPDATE ON answer_reviews TO concierge_app");

      expect(lastTally).toMatchObject({ dead: 1 });
      const rows = await reviewRows();
      expect(rows[0]).toMatchObject({ status: "dead", attempts: REVIEW_MAX_ATTEMPTS });
      // A dead row still records when it was given up on, so "why did this stop" is
      // answerable from the row rather than from a log nobody has.
      expect(rows[0]!.next_attempt_at).not.toBeNull();
      expect(await outboundCount(answeredConversation)).toBe(1);

      // And a dead row is claimable-by-hand again: 0027's unique index excludes
      // `dead`, because the fix for a dead row is a human one.
      const requeued = await client.query<{ outbox_id: string }>(
        `INSERT INTO outbox (org_id, property_id, kind, payload, status)
         VALUES ($1, $2, 'review', $3::jsonb, 'pending')
         ON CONFLICT (property_id, ((payload ->> 'ai_run_id')))
           WHERE kind = 'review' AND status IN ('pending', 'sending', 'failed')
           DO NOTHING
         RETURNING outbox_id`,
        [tenantA.orgId, tenantA.propertyId, JSON.stringify(rows[0]!.payload)],
      );
      expect(requeued.rowCount).toBe(1);
      // Removed again: it references an answer that already has a disposition, and
      // leaving it pending would make the next case claim it before its own row.
      await client.query("DELETE FROM outbox WHERE outbox_id = $1", [requeued.rows[0]!.outbox_id]);
    });

    it("marks a review for a deleted run done instead of retrying it forever", async () => {
      const orphan = await client.query<{ outbox_id: string }>(
        `INSERT INTO outbox (org_id, property_id, kind, payload, status)
         VALUES ($1, $2, 'review',
                 '{"ai_run_id":"00000000-0000-4000-8000-000000000009"}'::jsonb, 'pending')
         RETURNING outbox_id`,
        [tenantA.orgId, tenantA.propertyId],
      );
      const tally = await processReviewOutbox(pool);
      expect(tally).toMatchObject({ completed: 1, failed: 0 });
      const row = await client.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM outbox WHERE outbox_id = $1",
        [orphan.rows[0]!.outbox_id],
      );
      // Retrying a run that will never come back would burn attempts toward `dead`
      // and produce an alert about nothing.
      expect(row.rows[0]).toMatchObject({ status: "sent", attempts: 1 });
    });
  });

  describe("what the disposition says", () => {
    /** A run of one decision, inserted directly: the pipeline is not the subject
     * here, the worker's reading of `ai_runs.decision` is. */
    async function seedRun(decision: string, reasonCode: string | null): Promise<string> {
      const run = await client.query<{ ai_run_id: string }>(
        `INSERT INTO ai_runs
           (org_id, property_id, conversation_id, model_id, prompt_version, decision, reason_code)
         VALUES ($1, $2, $3, 'stub-model-2026-01-01', 'v1', $4, $5)
         RETURNING ai_run_id`,
        [tenantA.orgId, tenantA.propertyId, conversationId, decision, reasonCode],
      );
      const aiRunId = run.rows[0]!.ai_run_id;
      await client.query(
        `INSERT INTO outbox (org_id, property_id, kind, payload, status)
         VALUES ($1, $2, 'review', $3::jsonb, 'pending')`,
        [tenantA.orgId, tenantA.propertyId, JSON.stringify({ ai_run_id: aiRunId, conversation_id: conversationId })],
      );
      await processReviewOutbox(pool);
      const disposition = await client.query<{ needs_review: boolean; reason: string }>(
        "SELECT needs_review, reason FROM answer_reviews WHERE ai_run_id = $1",
        [aiRunId],
      );
      expect(disposition.rowCount).toBe(1);
      return `${disposition.rows[0]!.needs_review}|${disposition.rows[0]!.reason}`;
    }

    it("leaves an answer that went out alone", async () => {
      const turn = await ask();
      expect(turn.decision).toBe("answer");
      const queued = (await reviewRows()).filter(
        (row) => row.payload["conversation_id"] === turn.conversationId,
      );
      expect(queued).toHaveLength(1);
      await processReviewOutbox(pool);
      const disposition = await client.query<{ needs_review: boolean; reason: string }>(
        "SELECT needs_review, reason FROM answer_reviews WHERE ai_run_id = $1",
        [queued[0]!.payload["ai_run_id"]],
      );
      expect(disposition.rows[0]).toMatchObject({ needs_review: false, reason: "answered" });
    });

    it("sends an escalation to a human, and carries the reason", async () => {
      expect(await seedRun("escalate", "contract_violation")).toBe("true|escalated:contract_violation");
      expect(await seedRun("escalate", null)).toBe("true|escalated");
    });

    it("leaves a no_answer to the knowledge-gap queue instead of claiming it twice", async () => {
      // S09-02 already holds this miss, with the verbatim question and a hit count.
      // A second queue for one fact is how two numbers start disagreeing.
      expect(await seedRun("no_answer", "low_retrieval")).toBe(
        "false|no_answer_owned_by_gap_queue",
      );
    });

    it("queues nothing in draft mode, because draft mode produces no run", async () => {
      // The finding this item is designed around, kept as a regression test.
      // S08-04's draft mode escalates with ZERO provider calls, so there is no
      // ai_runs row and nothing to dispose of — a "needs_review when draft" rule
      // would be a rule that can never be true. Draft mode's queue is the inbox.
      await client.query("UPDATE properties SET ai_mode = 'draft' WHERE property_id = $1", [
        tenantB.propertyId,
      ]);
      try {
        const before = (await reviewRows()).length;
        const turn = await ask("¿A qué hora abre la alberca?", SLUG_B);
        expect(turn.decision).toBe("escalate");
        expect(await reviewRows()).toHaveLength(before);
      } finally {
        await client.query("UPDATE properties SET ai_mode = 'auto' WHERE property_id = $1", [
          tenantB.propertyId,
        ]);
      }
    });
  });

  describe("tenancy", () => {
    it("processes each row under its own tenant, so dispositions land where they belong", async () => {
      // Two properties, two queued answers, one worker loop: the claim is the only
      // cross-tenant read, and the work runs under the row's own GUCs.
      await client.query("DELETE FROM outbox WHERE kind = 'review'");
      await client.query("DELETE FROM answer_reviews");
      await ask("¿A qué hora abre la alberca?", SLUG_A);
      await ask("¿A qué hora abre la alberca?", SLUG_B);

      const tally = await processReviewOutbox(pool);
      expect(tally).toMatchObject({ claimed: 2, completed: 2 });

      const byProperty = await client.query<{ property_id: string; n: string }>(
        "SELECT property_id::text, count(*)::text AS n FROM answer_reviews GROUP BY property_id",
      );
      expect(byProperty.rows).toHaveLength(2);
      for (const row of byProperty.rows) {
        expect([tenantA.propertyId, tenantB.propertyId]).toContain(row.property_id);
        expect(Number(row.n)).toBe(1);
      }
      // And the foreign conversation's single reply was not duplicated by any of it.
      expect(await outboundCount(answeredConversation)).toBe(1);
    });

    it("two workers claim different rows rather than queueing behind each other", async () => {
      // SKIP LOCKED, not plain FOR UPDATE: the second claimer must get a different
      // row (or nothing), never the same one, and must not block.
      await client.query("DELETE FROM outbox WHERE kind = 'review'");
      await client.query("DELETE FROM answer_reviews");
      await ask("¿A qué hora abre la alberca?", SLUG_A);
      await ask("¿A qué hora abre la alberca?", SLUG_B);

      const first = await pool.connect();
      const second = await pool.connect();
      try {
        const claim = async (c: pg.PoolClient) => {
          await c.query("BEGIN");
          await c.query("SET LOCAL ROLE concierge_app");
          const rows = await c.query<{ claimed_id: string }>("SELECT * FROM claim_review_outbox(1)");
          return rows.rows.map((row) => row.claimed_id);
        };
        const a = await claim(first);
        const b = await claim(second);
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
        expect(a[0]).not.toBe(b[0]);
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");
      } finally {
        first.release();
        second.release();
      }
    });

    it("will not let the application role delete a disposition", async () => {
      // 0027 revokes DELETE, and — as 0026 established — a GRANT list does not
      // remove what 0002's default privileges already gave, so the revocation is
      // asserted rather than assumed.
      // Self-sufficient: the SKIP LOCKED case above rolls its claims back and
      // deletes the dispositions, so this one produces its own.
      await client.query("DELETE FROM outbox WHERE kind = 'review'");
      await client.query("DELETE FROM answer_reviews");
      await ask();
      await processReviewOutbox(pool);
      const rows = await client.query<{ ai_run_id: string }>(
        "SELECT ai_run_id::text FROM answer_reviews WHERE property_id = $1 LIMIT 1",
        [tenantA.propertyId],
      );
      expect(rows.rowCount).toBe(1);
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE concierge_app");
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [tenantA.orgId]);
        await client.query("SELECT set_config('app.current_property_id', $1, true)", [tenantA.propertyId]);
        const code = await client
          .query("DELETE FROM answer_reviews WHERE ai_run_id = $1", [rows.rows[0]!.ai_run_id])
          .then(
            () => null,
            (error: unknown) => (error as { code?: string }).code ?? "unknown",
          );
        await client.query("ROLLBACK");
        expect(code).toBe("42501");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  });
});
