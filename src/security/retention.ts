/**
 * S11-03 / AC-2 — the retention window, as one statement.
 *
 * Split from `scripts/retention.ts` so the behaviour can be tested without spawning a
 * CLI: the script owns argument parsing, property enumeration and the dry-run/report
 * shape; this owns the only thing that destroys data.
 *
 * ## What is deleted, and what is not
 *
 * The **text** is deleted; the row is kept. `body` becomes empty and
 * `body_redacted_at` records when. Deleting rows would rewrite every historical count
 * that reads `messages` — conversation totals, the inbound/outbound reconciliation,
 * S10-02's rollups for old days — and retention is about the guest's words, not about
 * the hotel's numbers. `events` is untouched for the same reason: it holds counts and
 * ids, and since 0030 it cannot hold the text either.
 *
 * ## The predicate is written once
 *
 * Dry-run and apply share `RETENTION_PREDICATE`. A dry run that used a slightly
 * different predicate than the delete would be the worst kind of safety feature: it
 * would report a number nobody then acts on.
 *
 * `body <> ''` makes the operation idempotent — an already-redacted row is not
 * counted twice, so a second run over the same window reports 0 rather than inventing
 * work it did not do.
 */
import type pg from "pg";
import { withTenant, type TenantContext } from "../db/tenant.ts";

export interface RetentionOptions {
  /** The property's `settings.retention_days` (default 90), or an explicit override. */
  days: number;
  /** False is a dry run: count, change nothing. */
  apply: boolean;
}

export interface RetentionOutcome {
  days: number;
  /** Messages that were (or would be) redacted. */
  count: number;
  applied: boolean;
}

export const RETENTION_PREDICATE = `org_id = $1 AND property_id = $2
   AND body_redacted_at IS NULL
   AND body <> ''
   AND created_at < now() - ($3::int * interval '1 day')`;

/**
 * Redact (or count) one property's expired message bodies.
 *
 * Runs under `withTenant`, in its own transaction, so a failure here rolls back this
 * property only — the caller iterates tenants and collects failures.
 */
export async function redactExpiredMessages(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  options: RetentionOptions,
): Promise<RetentionOutcome> {
  if (!Number.isInteger(options.days) || options.days < 1) {
    throw new Error(`retention: days must be a positive integer, got ${String(options.days)}`);
  }

  return withTenant(client, context, async (scoped) => {
    if (!options.apply) {
      const counted = await scoped.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM messages WHERE ${RETENTION_PREDICATE}`,
        [context.orgId, context.propertyId, options.days],
      );
      return { days: options.days, count: Number(counted.rows[0]!.n), applied: false };
    }

    const updated = await scoped.query<{ message_id: string }>(
      `UPDATE messages
          SET body = '', body_redacted_at = now()
        WHERE ${RETENTION_PREDICATE}
        RETURNING message_id`,
      [context.orgId, context.propertyId, options.days],
    );
    return { days: options.days, count: updated.rowCount ?? 0, applied: true };
  });
}
