/**
 * S09-03 — one-click "wrong or outdated", attributable to the `ai_run`.
 *
 * AC-1: one click creates a flag row naming the run, the staff user, the time and
 * an optional note. AC-2: the detail view shows it and `answer_flagged_wrong` is
 * emitted.
 *
 * ## What "one click" has to survive
 *
 * The click happens on a phone, in a lobby, on a connection that drops. So a
 * second click is a retry and not a second opinion: the unique index in 0026
 * refuses it, this service reports `created: false`, and no second event or audit
 * row is written. Nine flags from one person would read as nine people, which is
 * the same inflation the gap queue's `hits` exists to avoid.
 *
 * ## Append-only, enforced by privilege and not by convention
 *
 * 0026 grants `concierge_app` SELECT and INSERT on `answer_flags` and nothing
 * else. That is not tidiness: it means `ON CONFLICT DO UPDATE` is not available
 * here even by accident, so a flag can never be quietly rewritten or withdrawn by
 * a route bug. A disputed flag stays disputed, in public, which is the only reason
 * to trust the count.
 *
 * ## Whose name is on it
 *
 * `flagged_by` is stored and is the attribution the AC asks for. It cannot be
 * *displayed* as a name for anybody but the caller: 0004's `users.staff_select`
 * policy authorises your own row only, so a join for a colleague's display_name
 * returns NULL for everyone else. Widening that policy would expose staff emails
 * and names across a property, which is an S02 security decision and not something
 * to slip into this item. So the screen shows how many people flagged an answer,
 * the notes they left, and whether you are one of them.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import type { StaffSession } from "../auth/context.ts";
import { emitEvent } from "../events/emit.ts";
import { CREATED_AT_ISO_SQL, type CreatedAtIsoRow } from "../events/clock.ts";
import { writeAudit } from "../audit/write.ts";
import type { Lang } from "../i18n/catalog.ts";

/** 0026's CHECK is the authority; this is the same number so the refusal is a 400
 * from the API rather than a constraint violation from the database. */
export const FLAG_NOTE_MAX = 2000;

export class FlagNotFoundError extends Error {}
export class FlagInputError extends Error {}

export interface AnswerFlag {
  flagId: string;
  /** The attribution. A UUID, because the name behind it is not readable — see
   * the module comment. */
  flaggedBy: string;
  /** True when the caller is the one who flagged it. */
  mine: boolean;
  note: string | null;
  createdAt: string;
}

export interface FlaggedAnswer {
  flagId: string | null;
  /** False when this caller had already flagged this answer: a retry, not a
   * second opinion, and nothing was written. */
  created: boolean;
}

/**
 * Flags one answer.
 *
 * The run is read back inside the caller's transaction before the insert, so the
 * 404 for "no such answer" and the 404 for "somebody else's answer" are the same
 * answer — a caller cannot learn that a run id is real by getting a different
 * status for it. The composite FK in 0026 is the backstop if that read is ever
 * removed: a foreign `(org, property, run)` triple cannot be referenced at all.
 */
export async function flagAnswer(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  input: { aiRunId: string; note?: string | null; language?: Lang | null },
): Promise<FlaggedAnswer> {
  session.requireRole("queue", "write");
  assertTenantShape(context);

  const note = input.note === undefined || input.note === null ? null : input.note.trim();
  if (note !== null && (note === "" || note.length > FLAG_NOTE_MAX)) {
    throw new FlagInputError(
      note === "" ? "note must not be empty — omit it instead" : `note is longer than ${FLAG_NOTE_MAX} characters`,
    );
  }

  const run = await client.query<{ ai_run_id: string; conversation_id: string; decision: string }>(
    `SELECT ai_run_id, conversation_id, decision FROM ai_runs
      WHERE org_id = $1 AND property_id = $2 AND ai_run_id = $3`,
    [context.orgId, context.propertyId, input.aiRunId],
  );
  const target = run.rows[0];
  if (target === undefined) throw new FlagNotFoundError(`no such answer: ${input.aiRunId}`);

  const inserted = await client.query<{ flag_id: string } & CreatedAtIsoRow>(
    `INSERT INTO answer_flags (org_id, property_id, ai_run_id, flagged_by, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, property_id, ai_run_id, flagged_by) DO NOTHING
     RETURNING flag_id, ${CREATED_AT_ISO_SQL}`,
    [context.orgId, context.propertyId, input.aiRunId, session.userUuid, note],
  );
  if (inserted.rowCount !== 1) return { flagId: null, created: false };

  const flagId = inserted.rows[0]!.flag_id;
  // Issue #147 option 3 — the flag row's own created_at, not a fresh JS reading.
  // `answer_flags` is one of the eight reconciled pairs, so a window boundary
  // between the row and its event used to read as a missing instrumentation.
  const at = inserted.rows[0]!.created_at_iso;

  await emitEvent(
    client,
    context,
    "answer_flagged_wrong",
    {
      orgId: context.orgId,
      propertyId: context.propertyId,
      conversationId: target.conversation_id,
      channel: "web",
      language: input.language ?? null,
      topic: null,
      createdAt: at,
    },
    {
      ai_run_id: input.aiRunId,
      flag_id: flagId,
      actor_user_id: session.userUuid,
      decision: target.decision,
      ...(note === null ? {} : { note }),
    },
  );

  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: session.userUuid,
    action: "answer.flagged",
    entityType: "ai_run",
    entityId: input.aiRunId,
    detail: { flag_id: flagId, ...(note === null ? {} : { note }) },
  });

  return { flagId, created: true };
}

/**
 * The flags on a set of runs, grouped by run.
 *
 * One statement for the whole conversation rather than one per message: the
 * detail screen already makes several round trips, and a transcript of 100
 * messages would turn "is this answer flagged?" into 100 of them.
 */
export async function flagsForRuns(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  aiRunIds: readonly string[],
  callerUserId: string,
): Promise<Map<string, AnswerFlag[]>> {
  assertTenantShape(context);
  const grouped = new Map<string, AnswerFlag[]>();
  if (aiRunIds.length === 0) return grouped;

  const rows = await client.query<{
    ai_run_id: string;
    flag_id: string;
    flagged_by: string;
    note: string | null;
    created_at: Date;
  }>(
    `SELECT ai_run_id, flag_id, flagged_by, note, created_at
       FROM answer_flags
      WHERE org_id = $1 AND property_id = $2 AND ai_run_id = ANY($3::uuid[])
      ORDER BY created_at, flag_id`,
    [context.orgId, context.propertyId, [...aiRunIds]],
  );

  for (const row of rows.rows) {
    const flag: AnswerFlag = {
      flagId: row.flag_id,
      flaggedBy: row.flagged_by,
      mine: row.flagged_by === callerUserId,
      note: row.note,
      createdAt: row.created_at.toISOString(),
    };
    const existing = grouped.get(row.ai_run_id);
    if (existing === undefined) grouped.set(row.ai_run_id, [flag]);
    else existing.push(flag);
  }
  return grouped;
}
