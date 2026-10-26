/**
 * S08-04 — the AI operating mode, read and written per property.
 *
 * AC (verbatim): *"Mode change applies to the next message, no deploy."*
 *
 * The policy itself already existed: `escalationDecision` in
 * `src/settings/policy.ts` is pure and takes the mode as an argument, and
 * `answerMessage` reads `properties.ai_mode` inside the request rather than
 * caching it at module load. What was missing was a *surface* to change it and a
 * test that proves the next message notices — which is why this module is thin on
 * purpose. Anything cached here would defeat the item's only acceptance criterion.
 *
 * ## Where the mode lives
 *
 * The charter says `property_settings`. The schema says `properties.ai_mode`
 * (0001) and that is where the seed, the policy gate and every existing test
 * already read it — `property_settings` as a distinct table does not exist in this
 * database; `properties.settings` is a JSONB column for the tunable policy
 * (topics, hours, caps, escalation contacts). The mode is a **column**, so it is
 * read and written here as one, and the charter's wording is corrected in §10
 * rather than by moving a live column.
 *
 * ## Why a dedicated writer instead of `savePropertySettings`
 *
 * `savePropertySettings` patches the JSONB column. `ai_mode` is not in it, and
 * folding a column into a JSONB patch helper would mean two storage shapes
 * pretending to be one. This writer validates against `AI_MODES`, refuses a
 * no-op write (no audit spam from a double click), and audits the change with the
 * previous value so "who turned the bot off, and when" is answerable.
 */
import type pg from "pg";
import { writeAudit } from "../audit/write.ts";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import type { StaffSession } from "../auth/context.ts";
import type { AiMode } from "./policy.ts";

/** The closed set, in product order. Mirrors 0001's CHECK on `properties.ai_mode`. */
export const AI_MODES = ["auto", "draft", "human_only", "after_hours"] as const;

export function isAiMode(value: unknown): value is AiMode {
  return typeof value === "string" && (AI_MODES as readonly string[]).includes(value);
}

export class ModeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeInputError";
  }
}

export class PropertyModeNotFoundError extends Error {
  constructor() {
    super("property not found in this tenant");
    this.name = "PropertyModeNotFoundError";
  }
}

export interface ModeState {
  aiMode: AiMode;
  /**
   * The zone the mode is evaluated in. Returned with the mode because
   * `after_hours` is meaningless without it, and a settings screen that shows the
   * mode but not the clock invites "why did it answer at 3am?".
   */
  timeZone: string;
}

/** Public getter: the settings screen shows the current mode and the clock it uses. */
export async function getAiMode(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
): Promise<ModeState> {
  session.requireRole("settings", "read");
  assertTenantShape(context);
  // `properties` has no `updated_at` column (0001); the change record is the
  // audit row this module writes, which is the more useful answer anyway.
  const result = await client.query<{ ai_mode: AiMode; time_zone: string }>(
    "SELECT ai_mode, time_zone FROM properties WHERE org_id = $1 AND property_id = $2",
    [context.orgId, context.propertyId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new PropertyModeNotFoundError();
  return { aiMode: row.ai_mode, timeZone: row.time_zone };
}

export interface SetModeResult {
  aiMode: AiMode;
  /** False when the property was already in this mode — a double click. */
  changed: boolean;
  previous: AiMode;
}

/**
 * Writes the mode. Takes effect for the NEXT message: `answerMessage` re-reads
 * `properties.ai_mode` at the start of every turn, so there is no cache to
 * invalidate and no process to restart (AC-2).
 */
export async function setAiMode(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  input: { mode: unknown },
): Promise<SetModeResult> {
  session.requireRole("settings", "write");
  assertTenantShape(context);
  if (!isAiMode(input.mode)) {
    throw new ModeInputError(`mode must be one of ${AI_MODES.join(", ")}`);
  }

  // `FOR UPDATE` because two admins toggling simultaneously must not both audit a
  // change from the same previous value (the audit is the record of intent).
  const current = await client.query<{ ai_mode: AiMode }>(
    "SELECT ai_mode FROM properties WHERE org_id = $1 AND property_id = $2 FOR UPDATE",
    [context.orgId, context.propertyId],
  );
  const row = current.rows[0];
  if (row === undefined) throw new PropertyModeNotFoundError();

  if (row.ai_mode === input.mode) {
    return { aiMode: row.ai_mode, changed: false, previous: row.ai_mode };
  }

  await client.query(
    "UPDATE properties SET ai_mode = $3 WHERE org_id = $1 AND property_id = $2",
    [context.orgId, context.propertyId, input.mode],
  );
  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: session.userUuid,
    action: "settings.updated",
    entityType: "property",
    entityId: context.propertyId,
    detail: { changed: ["ai_mode"], previous: row.ai_mode, ai_mode: input.mode },
  });

  return { aiMode: input.mode, changed: true, previous: row.ai_mode };
}
