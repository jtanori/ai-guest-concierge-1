/**
 * S09-02 — the knowledge-gap queue.
 *
 * AC-1: *every* `no_answer` lands here automatically, as one row per distinct
 * unanswered question per property, with the verbatim question, the language and
 * the count of times it was asked.
 *
 * AC-2: closing a gap emits `knowledge_gap_closed`, and the median age of what is
 * still open is computable — which is the number that says whether the queue is
 * being worked or merely being read.
 *
 * ## One writer
 *
 * Before this module there were two: `src/ai/answer.ts` wrote a gap on both
 * no-answer paths, and `src/requests/capture.ts` wrote one when it rode along
 * with a `no_answer` request — guarded only by a lookup scoped to the
 * *conversation*, so the same question asked in a second conversation was a
 * second row. Both now come through `recordGap`, and `capture.ts` reads rather
 * than writes. That is also what makes `hits` mean something: with two writers
 * the count would have been "how many code paths noticed", not "how many guests
 * asked".
 *
 * ## Why the queue is oldest-first
 *
 * `hits` is the most interesting column and deliberately *not* the sort key: it
 * is mutable, so a gap that keeps being asked moves while a reader pages through
 * the list, and keyset pagination over a moving key repeats and skips rows.
 * `created_at` is immutable, so the page after the cursor is exactly "the rest".
 * Hotness is a column on the row, not a property of the ordering — and
 * oldest-first is the order in which nothing that has gone unanswered for a month
 * can be pushed off the bottom by this morning's popular miss.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import type { StaffSession } from "../auth/context.ts";
import { emitEvent } from "../events/emit.ts";
import type { EventContext } from "../events/taxonomy.ts";
import { writeAudit } from "../audit/write.ts";
import { decodeCursor, encodeCursor, parseLimit } from "../inbox/queries.ts";
import type { Lang } from "../i18n/catalog.ts";

export class GapNotFoundError extends Error {}
export class GapInputError extends Error {}

export interface RecordGapInput {
  conversationId: string;
  /** Verbatim. Never normalised, trimmed of meaning, or translated: the content
   * owner is reading what the guest typed. */
  question: string;
  language: Lang | null;
  topic?: string | null;
}

export interface RecordedGap {
  gapId: string;
  /** True only on the insert. A repeat increments; it is not a new queue entry,
   * and must not emit a second `knowledge_gap_created`. */
  created: boolean;
  hits: number;
}

/**
 * Records one unanswered question, or counts another ask against the open one.
 *
 * The upsert is the whole of AC-1's "automatically": there is no branch in the
 * caller that can forget to check for an existing row, because the database is
 * what decides. `knowledge_gaps_open_question` (0025) is a *partial* unique index
 * on `status = 'open'`, so resolving a gap lets the same question be recorded
 * again — "we wrote the article and they are still asking" is a different fact
 * from "we never answered", and merging them would hide the first one.
 */
export async function recordGap(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: RecordGapInput,
  eventBase: EventContext,
  why: { reasonCode: string },
): Promise<RecordedGap> {
  assertTenantShape(context);
  if (typeof input.question !== "string" || input.question.trim() === "") {
    throw new GapInputError("a gap needs the question that was not answered");
  }

  const row = await client.query<{ gap_id: string; hits: number; inserted: boolean }>(
    `INSERT INTO knowledge_gaps
       (org_id, property_id, conversation_id, question, language, topic, status, hits)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', 1)
     ON CONFLICT (property_id, question_key) WHERE status = 'open'
     DO UPDATE SET
       -- One ask per TURN, not per call.
       --
       -- A single no-answer turn reaches this twice by design: the pipeline
       -- records the miss (src/ai/answer.ts) and then the request capture links
       -- the escalation to it (src/requests/capture.ts). Both are inside the one
       -- guest transaction. Counting both would make hits exactly double the
       -- number of guests who asked, which is the kind of wrong that looks
       -- plausible on a dashboard for months.
       --
       -- xmin is the transaction that wrote the row, so "this row was written
       -- by the transaction I am in" is the precise test for "already counted
       -- this turn". A later turn — the same guest asking again tomorrow, or a
       -- different guest asking at all — has a different xmin and increments.
       -- Verified against PostgreSQL 16.2 in tests/db/gaps.db.test.ts.
       hits = knowledge_gaps.hits + CASE
                WHEN knowledge_gaps.xmin = pg_current_xact_id()::xid THEN 0 ELSE 1
              END,
       -- Fill in what the first sighting did not know rather than overwriting it:
       -- the earliest row wins on identity, the latest on missing detail.
       topic = COALESCE(knowledge_gaps.topic, EXCLUDED.topic),
       language = COALESCE(knowledge_gaps.language, EXCLUDED.language)
     RETURNING gap_id, hits, (xmax = 0) AS inserted`,
    [
      context.orgId,
      context.propertyId,
      input.conversationId,
      input.question,
      input.language,
      input.topic ?? null,
    ],
  );

  const recorded = row.rows[0]!;
  // `xmax = 0` is the row's "nobody has superseded me yet", which is true only
  // for the tuple this statement inserted and false for one it updated. It is the
  // difference between "a new entry joined the queue" and "an existing entry was
  // touched" — and only the first may emit `knowledge_gap_created`, or a repeat
  // ask would look like new work to anything downstream counting those events.
  const created = recorded.inserted;

  if (created) {
    await emitEvent(client, context, "knowledge_gap_created", eventBase, {
      gap_id: recorded.gap_id,
      question: input.question,
      reason_code: why.reasonCode,
    });
  }

  return { gapId: recorded.gap_id, created, hits: recorded.hits };
}

export interface GapItem {
  gapId: string;
  question: string;
  language: string | null;
  topic: string | null;
  hits: number;
  createdAt: string;
  /** Whole seconds open, from the same clock as everything else the queue shows. */
  openSeconds: number;
  conversationId: string | null;
}

export interface GapPage {
  items: GapItem[];
  nextCursor: string | null;
  /** Appendix D's target is ≤7 days; `null` when nothing is open. */
  medianOpenAgeDays: number | null;
  openCount: number;
}

/**
 * The queue the content owner reads: open gaps, oldest first, paged by keyset.
 *
 * The median rides along with the page rather than being its own endpoint,
 * because the two are read together and answering them separately would mean the
 * number on screen was computed from a different moment than the list under it.
 */
export async function listOpenGaps(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  input: { limit?: number | string | null; cursor?: string | null } = {},
): Promise<GapPage> {
  session.requireRole("knowledge", "read");
  assertTenantShape(context);

  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);

  const page = await client.query<{
    gap_id: string;
    question: string;
    language: string | null;
    topic: string | null;
    hits: number;
    conversation_id: string | null;
    created_at: Date;
    open_seconds: string;
  }>(
    `SELECT gap_id, question, language, topic, hits, conversation_id, created_at,
            FLOOR(EXTRACT(EPOCH FROM (now() - created_at)))::text AS open_seconds
       FROM knowledge_gaps
      WHERE org_id = $1 AND property_id = $2 AND status = 'open'
        AND ($3::timestamptz IS NULL OR (created_at, gap_id) > ($3::timestamptz, $4::uuid))
      ORDER BY created_at, gap_id
      LIMIT $5`,
    [
      context.orgId,
      context.propertyId,
      cursor === null ? null : cursor.at,
      cursor === null ? null : cursor.id,
      limit + 1,
    ],
  );

  const rows = page.rows.slice(0, limit);
  const next = page.rows[limit];
  const median = await medianOpenAge(client, context);

  return {
    items: rows.map((row) => ({
      gapId: row.gap_id,
      question: row.question,
      language: row.language,
      topic: row.topic,
      hits: row.hits,
      conversationId: row.conversation_id,
      createdAt: row.created_at.toISOString(),
      openSeconds: Number(row.open_seconds),
    })),
    nextCursor:
      next === undefined
        ? null
        : encodeCursor({ at: next.created_at.toISOString(), id: next.gap_id }),
    medianOpenAgeDays: median.medianOpenAgeDays,
    openCount: median.openCount,
  };
}

/**
 * Median age of the open gaps, in days.
 *
 * `percentile_cont` rather than a mean, and rather than computing it in
 * TypeScript from a fetched page: a mean is dragged by the one gap nobody has
 * touched since launch, and a page is not the population. In SQL it is one pass
 * over the rows the tenant predicate already selected.
 */
export async function medianOpenAge(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<{ medianOpenAgeDays: number | null; openCount: number }> {
  assertTenantShape(context);
  const row = await client.query<{ median_days: number | null; open_count: string }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0
            ) AS median_days,
            count(*)::text AS open_count
       FROM knowledge_gaps
      WHERE org_id = $1 AND property_id = $2 AND status = 'open'`,
    [context.orgId, context.propertyId],
  );
  const median = row.rows[0]!.median_days;
  return {
    medianOpenAgeDays: median === null ? null : Number(median),
    openCount: Number(row.rows[0]!.open_count),
  };
}

export interface ClosedGap {
  gapId: string;
  /** False when the gap was already closed: a second click is a no-op, not an
   * error, because the screen does not know who else is looking at it. */
  changed: boolean;
  resolvedAt: string | null;
  openAgeDays: number | null;
}

/**
 * Closes a gap: `knowledge:write`, so an owner or a manager — the roles that can
 * publish the article that answers it. A front desk can read the queue and cannot
 * close it, because closing is a claim that the content now exists.
 */
export async function closeGap(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  gapId: string,
): Promise<ClosedGap> {
  session.requireRole("knowledge", "write");
  assertTenantShape(context);

  const row = await client.query<{
    status: string;
    conversation_id: string | null;
    created_at: Date;
    resolved_at: Date | null;
    hits: number;
  }>(
    `SELECT status, conversation_id, created_at, resolved_at, hits
       FROM knowledge_gaps
      WHERE org_id = $1 AND property_id = $2 AND gap_id = $3 FOR UPDATE`,
    [context.orgId, context.propertyId, gapId],
  );
  const gap = row.rows[0];
  // One 404 for "no such gap" and "somebody else's gap": a 403 would confirm the
  // id is real, which is the same reason the guest surface does not distinguish.
  if (gap === undefined) throw new GapNotFoundError(`no such gap: ${gapId}`);

  if (gap.status === "resolved") {
    return {
      gapId,
      changed: false,
      resolvedAt: gap.resolved_at === null ? null : gap.resolved_at.toISOString(),
      openAgeDays:
        gap.resolved_at === null
          ? null
          : (gap.resolved_at.getTime() - gap.created_at.getTime()) / 86_400_000,
    };
  }

  const closed = await client.query<{ resolved_at: Date }>(
    `UPDATE knowledge_gaps SET status = 'resolved', resolved_at = now()
      WHERE org_id = $1 AND property_id = $2 AND gap_id = $3
      RETURNING resolved_at`,
    [context.orgId, context.propertyId, gapId],
  );
  const resolvedAt = closed.rows[0]!.resolved_at;

  // The event needs a conversation, because `events.conversation_id` is NOT NULL
  // and the canonical shape requires a UUID. A gap whose conversation was deleted
  // (the FK is ON DELETE SET NULL) therefore cannot emit one — the close still
  // happens and is still audited, and the audit says so rather than letting the
  // hole in the event log be silent.
  const conversationId = gap.conversation_id;
  const eventEmitted = conversationId !== null;
  if (conversationId !== null) {
    await emitEvent(
      client,
      context,
      "knowledge_gap_closed",
      {
        orgId: context.orgId,
        propertyId: context.propertyId,
        conversationId,
        channel: "web",
        language: null,
        topic: null,
        createdAt: resolvedAt.toISOString(),
      },
      {
        gap_id: gapId,
        actor_user_id: session.userUuid,
        hits: gap.hits,
        open_age_days: (resolvedAt.getTime() - gap.created_at.getTime()) / 86_400_000,
      },
    );
  }

  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: session.userUuid,
    action: "knowledge_gap.closed",
    entityType: "knowledge_gap",
    entityId: gapId,
    detail: { hits: gap.hits, event_emitted: eventEmitted },
  });

  return {
    gapId,
    changed: true,
    resolvedAt: resolvedAt.toISOString(),
    openAgeDays: (resolvedAt.getTime() - gap.created_at.getTime()) / 86_400_000,
  };
}
