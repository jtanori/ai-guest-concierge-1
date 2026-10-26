/**
 * S09-04 — review work that cannot delay a guest.
 *
 * AC-1: the outbound guest message is committed before any review work starts.
 * AC-2: review work is retried from the outbox on failure, and a failure never
 * re-sends the guest message.
 *
 * ## The shape of the guarantee
 *
 * It is not "review is fast". It is that review is **not on the guest's path at
 * all**. The turn writes the reply and an outbox row in ONE transaction and
 * commits; only then can anything read the row. So:
 *
 *  - review machinery that is slow, broken or absent cannot delay a reply, because
 *    the reply is already committed before the first read;
 *  - there is no window where the reply exists and the review work was lost, nor
 *    one where review work exists for a reply that was rolled back — they share a
 *    commit;
 *  - AC-2's "never re-sends" is structural rather than a check: this module's
 *    worker touches `outbox` and `answer_reviews` and nothing else. It holds no
 *    provider, no channel adapter and no reference to `insertMessage`, so there is
 *    no code path by which a retry could produce a second guest message.
 *
 * `tests/db/review-queue.db.test.ts` asserts the message count across a failing
 * worker and a replay, because "cannot" is a claim worth checking.
 *
 * ## Why the enqueue can never break the reply
 *
 * `enqueueReview` runs inside the guest's transaction, so any error it raised
 * would roll the reply back — the opposite of AC-1. It therefore uses
 * `ON CONFLICT … DO NOTHING` against 0027's partial unique index rather than a
 * read-then-insert: the statement cannot raise on a duplicate, so there is nothing
 * to catch and no need for a savepoint inside somebody else's transaction.
 *
 * ## Scope
 *
 * This is the minimal claim loop §8 asks for. S11-01 owns the production worker:
 * a reaper for rows stranded in `sending` (this loop never writes that status, so
 * it cannot strand one), jitter on the backoff, concurrency limits, and metrics.
 * The conventions it inherits are set here — attempts, exponential backoff, `dead`
 * after `REVIEW_MAX_ATTEMPTS`.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";

export const REVIEW_OUTBOX_KIND = "review";

/** After this many failures a row is `dead`: retried forever is an alert nobody
 * hears. `dead` is deliberately re-queueable by hand (0027's unique index excludes
 * it), because the fix for a dead row is a human one. */
export const REVIEW_MAX_ATTEMPTS = 5;

/**
 * Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at a minute.
 *
 * No jitter, and that is a known gap rather than an oversight — with one worker
 * there is nothing to thundering-herd, and S11-01 runs more than one. Recorded
 * here so the omission is a decision somebody can find rather than a thing nobody
 * thought about.
 */
export function reviewBackoffMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

export interface EnqueuedReview {
  /** False when a review for this answer was already queued. */
  enqueued: boolean;
  outboxId: string | null;
}

/**
 * Queues the review work for one answer, in the caller's transaction.
 *
 * Cheap on purpose: one INSERT that cannot raise. Everything expensive happens
 * after the commit, in `processReviewOutbox`.
 */
export async function enqueueReview(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: { aiRunId: string; conversationId: string; messageId?: string | null },
): Promise<EnqueuedReview> {
  assertTenantShape(context);
  const inserted = await client.query<{ outbox_id: string }>(
    `INSERT INTO outbox (org_id, property_id, kind, payload, status)
     VALUES ($1, $2, 'review', $3::jsonb, 'pending')
     ON CONFLICT (property_id, ((payload ->> 'ai_run_id')))
       WHERE kind = 'review' AND status IN ('pending', 'sending', 'failed')
       DO NOTHING
     RETURNING outbox_id`,
    [
      context.orgId,
      context.propertyId,
      JSON.stringify({
        ai_run_id: input.aiRunId,
        conversation_id: input.conversationId,
        ...(input.messageId === undefined || input.messageId === null
          ? {}
          : { message_id: input.messageId }),
      }),
    ],
  );
  return {
    enqueued: inserted.rowCount === 1,
    outboxId: inserted.rows[0]?.outbox_id ?? null,
  };
}

export interface ReviewWorkerTally {
  /** Rows claimed. 0 means the queue was empty or nothing was due yet. */
  claimed: number;
  completed: number;
  failed: number;
  dead: number;
}

interface ClaimedRow {
  claimed_id: string;
  claimed_org: string;
  claimed_property: string;
  claimed_payload: { ai_run_id?: string; conversation_id?: string };
  claimed_attempts: number;
}

/**
 * Claims and processes due review rows, one transaction per row.
 *
 * One row at a time rather than a batch, and this is load-bearing: `FOR UPDATE
 * SKIP LOCKED` holds its lock only for the duration of the transaction that took
 * it, so a batch claimed up front would be unlocked again before any of it was
 * processed, and a second worker would claim the same rows. Claiming inside the
 * work transaction also means this loop never writes `status = 'sending'`, so it
 * cannot strand a row that a dead worker was holding — the failure mode S11-01's
 * reaper exists for.
 */
export async function processReviewOutbox(
  pool: pg.Pool,
  options: { maxRows?: number; now?: () => Date } = {},
): Promise<ReviewWorkerTally> {
  const maxRows = options.maxRows ?? 100;
  const tally: ReviewWorkerTally = { claimed: 0, completed: 0, failed: 0, dead: 0 };

  for (let i = 0; i < maxRows; i += 1) {
    const client = await pool.connect();
    try {
      const outcome = await processOne(client);
      if (outcome === null) break; // nothing due: stop, do not spin
      tally.claimed += 1;
      tally[outcome] += 1;
    } finally {
      client.release();
    }
  }
  return tally;
}

type Outcome = "completed" | "failed" | "dead";

async function processOne(client: pg.PoolClient): Promise<Outcome | null> {
  let claimed: ClaimedRow | null = null;
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");
    // The one cross-tenant read, through the definer function 0027 added and 0028
    // generalised to every kind: `outbox` is FORCE RLS, so without it a worker sees
    // no rows at all.
    const rows = await client.query<ClaimedRow>(
      "SELECT * FROM claim_outbox($1, 1)",
      [REVIEW_OUTBOX_KIND],
    );
    if (rows.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    claimed = rows.rows[0]!;

    // From here the row's own tenant is the context, and the work runs as
    // concierge_app under ordinary RLS — the definer window was only the claim.
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [claimed.claimed_org]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [
      claimed.claimed_property,
    ]);

    await reviewOne(client, {
      orgId: claimed.claimed_org,
      propertyId: claimed.claimed_property,
      aiRunId: claimed.claimed_payload.ai_run_id ?? "",
    });

    await client.query(
      `UPDATE outbox
          SET status = 'sent', processed_at = now(), attempts = attempts + 1, last_error = NULL
        WHERE outbox_id = $1`,
      [claimed.claimed_id],
    );
    await client.query("COMMIT");
    return "completed";
  } catch (error) {
    await client.query("ROLLBACK");
    // Bookkeeping happens in its own transaction: the one above is rolled back, so
    // recording the attempt inside it would have recorded nothing.
    return recordFailure(client, claimed, error);
  }
}

/**
 * The work itself: one disposition per answer.
 *
 * ## What "needs review" means, and why it is not a new policy
 *
 * The rule reads one column the pipeline already writes: `ai_runs.decision`.
 *
 *  - `answer` — it went out, the guardrails passed and the citations were
 *    reconstructed. Nothing to review.
 *  - `escalate` — a human was asked to take over *after* the model was consulted
 *    (a contract violation, an outage, a fallback). That is exactly what a review
 *    queue is for, and the run's own `reason_code` says why.
 *  - `no_answer` — deliberately NOT reviewed here. The knowledge-gap queue
 *    (S09-02) already owns that miss, with the verbatim question and a hit count;
 *    a second queue for one fact is how the two drift apart and the count gets
 *    double-read.
 *
 * The obvious alternative — "needs review when the property is in `draft` mode",
 * which is what S08-04's wording suggests — does not work, and finding that out is
 * worth recording: in `draft` mode the pipeline escalates with **zero provider
 * calls**, so there is no `ai_runs` row and therefore no answer to dispose of.
 * Draft mode's queue is the inbox, where a human writes the reply; it is not this
 * table. A rule that can never be true is not a rule.
 *
 * No confidence threshold, because `settings` has none: inventing one here would
 * have been a second, undocumented policy hiding inside a plumbing item.
 *
 * Idempotent by primary key: a replayed row inserts nothing and, crucially, does
 * not overwrite the first disposition's reason.
 */
async function reviewOne(
  client: pg.Client | pg.PoolClient,
  input: { orgId: string; propertyId: string; aiRunId: string },
): Promise<void> {
  if (input.aiRunId === "") throw new Error("review payload names no ai_run_id");

  const run = await client.query<{ decision: string; reason_code: string | null }>(
    `SELECT decision, reason_code
       FROM ai_runs
      WHERE org_id = $1 AND property_id = $2 AND ai_run_id = $3`,
    [input.orgId, input.propertyId, input.aiRunId],
  );
  if (run.rowCount === 0) {
    // The run is gone (its conversation was deleted, cascading). There is nothing
    // to dispose of, and retrying would never find it: mark it done rather than
    // burning attempts toward `dead`.
    return;
  }

  const { decision, reason_code: reasonCode } = run.rows[0]!;
  const needsReview = decision === "escalate";
  const reason = needsReview
    ? `escalated${reasonCode === null ? "" : `:${reasonCode}`}`
    : decision === "no_answer"
      ? "no_answer_owned_by_gap_queue"
      : "answered";

  await client.query(
    `INSERT INTO answer_reviews (org_id, property_id, ai_run_id, needs_review, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, property_id, ai_run_id) DO NOTHING`,
    [input.orgId, input.propertyId, input.aiRunId, needsReview, reason],
  );
}

/**
 * Records a failed attempt. Never throws: a worker that dies while reporting a
 * death is a worker that leaves no trace.
 */
async function recordFailure(
  client: pg.PoolClient,
  claimed: ClaimedRow | null,
  error: unknown,
): Promise<Outcome> {
  if (claimed === null) {
    // The claim itself failed, so there is no row to book-keep against. Report it
    // as a failure and let the caller's loop stop; the row is untouched and still
    // pending, which is the correct state.
    return "failed";
  }
  const attempts = claimed.claimed_attempts + 1;
  const dead = attempts >= REVIEW_MAX_ATTEMPTS;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE concierge_app");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [claimed.claimed_org]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [
      claimed.claimed_property,
    ]);
    await client.query(
      `UPDATE outbox
          SET attempts = $2,
              status = $3,
              -- Due-time is set even for a dead row, so "when did we give up" is
              -- answerable from the row rather than from a log nobody has.
              next_attempt_at = now() + make_interval(secs => $4),
              last_error = left($5, 500)
        WHERE outbox_id = $1`,
      [
        claimed.claimed_id,
        attempts,
        dead ? "dead" : "failed",
        reviewBackoffMs(attempts) / 1000,
        message,
      ],
    );
    await client.query("COMMIT");
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is unusable; the caller releases it and the row stays
      // pending, which is the safe state.
    }
  }
  return dead ? "dead" : "failed";
}
