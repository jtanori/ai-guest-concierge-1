/**
 * S04-01 — human approval gates publication, and a contradiction is closed by
 * a person.
 *
 * This is the first PRODUCTION caller of the surface matrix (S02-06): every
 * entry point starts with `session.requireRole("knowledge", "write")` before
 * it issues a query, so `front_desk` and `observer` are refused by the role
 * they actually hold in `memberships` — not by a token claim, not by a check a
 * route could forget. `tests/db/role-denial.db.test.ts` proves the denial
 * happens with zero writes.
 *
 * Two decisions live here, and both are ROWS, never mutable columns:
 *
 *   approveVersion / rejectVersion  write `article_reviews`. 0003 makes
 *     article_versions append-only (D5), and AC-1 only needs the decision to
 *     name its reviewer — a row does that better than a flag, because a
 *     re-approval moves the reviewer and the timestamp together instead of
 *     leaving a stale name behind.
 *
 *   resolveContradiction  verifies exactly ONE value in the group and records
 *     the group in `fact_resolutions`, which removes it from S03-03's
 *     `listContradictions` queue. It never verifies a second value: the
 *     partial unique index `property_facts_verified_key` (0009) would refuse
 *     it, and `verifyFact` refuses it first with both fact ids.
 */
import type pg from "pg";
import type { StaffSession } from "../auth/context.ts";
import { writeAudit } from "../audit/write.ts";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import {
  listContradictions,
  validateEffectiveFrom,
  validateFactKey,
  validateFactLanguage,
  verifyFact,
} from "./facts.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** A version id that is not in this tenant, indistinguishable from unknown. */
export class ReviewNotFoundError extends Error {
  constructor(articleVersionId: string) {
    super(`article_version ${articleVersionId} was not found in this tenant (or does not exist)`);
    this.name = "ReviewNotFoundError";
  }
}

export class ReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewInputError";
  }
}

/** The group is gone: already resolved, or never a contradiction. */
export class ContradictionGroupNotFoundError extends Error {
  constructor(key: string) {
    super(`no unresolved contradiction group ${key} in this tenant`);
    this.name = "ContradictionGroupNotFoundError";
  }
}

/** A winner has to be one of the row ids in the group. */
export class ContradictionWinnerError extends Error {
  constructor(winnerFactId: string, key: string) {
    super(`fact ${winnerFactId} is not part of contradiction group ${key}`);
    this.name = "ContradictionWinnerError";
  }
}

export interface ReviewQueueItem {
  articleVersionId: string;
  articleId: string;
  versionNo: number;
  isCurrent: boolean;
  /** "unreviewed" when no decision row exists yet. */
  status: ReviewStatus | "unreviewed";
  requestedAt: Date | null;
  reviewerUserId: string | null;
  decidedAt: Date | null;
}

export interface ReviewDecision {
  articleVersionId: string;
  versionNo: number;
  status: Exclude<ReviewStatus, "pending">;
}

export interface ResolveContradictionInput {
  topicKey: string;
  factKey: string;
  language: string;
  /** null addresses the legacy/undated group (S03-03 groups IS NOT DISTINCT). */
  effectiveFrom: string | null;
  winnerFactId: string;
}

export interface ContradictionResolution {
  topicKey: string;
  factKey: string;
  language: string;
  effectiveFrom: string | null;
  winnerFactId: string;
  /** The other values in the group; they stay unverified and never answer. */
  demotedFactIds: string[];
}

function assertUuid(value: string, field: string): void {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ReviewInputError(`${field} must be a UUID`);
  }
}

function groupKey(input: {
  topicKey: string;
  factKey: string;
  language: string;
  effectiveFrom: string | null;
}): string {
  return `${input.topicKey}/${input.factKey}/${input.language}/${input.effectiveFrom ?? "null"}`;
}

/**
 * The queue: every version without an approved decision, newest first. It is a
 * READ surface, so it needs `knowledge` read — front_desk holds that, observer
 * does too; the write guard lives on the decisions below.
 */
export async function listReviewQueue(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
): Promise<ReviewQueueItem[]> {
  session.requireRole("knowledge", "read");
  assertTenantShape(context);

  const result = await client.query<{
    article_version_id: string;
    article_id: string;
    version_no: number;
    is_current: boolean;
    status: ReviewStatus | null;
    requested_at: Date | null;
    reviewer_user_id: string | null;
    decided_at: Date | null;
  }>(
    `SELECT v.article_version_id, v.article_id, v.version_no, v.is_current,
            r.status, r.requested_at, r.reviewer_user_id, r.decided_at
       FROM article_versions v
       LEFT JOIN article_reviews r
         ON r.property_id = v.property_id
        AND r.article_version_id = v.article_version_id
      WHERE v.org_id = $1
        AND v.property_id = $2
        AND (r.status IS NULL OR r.status <> 'approved')
      ORDER BY v.created_at DESC, v.article_version_id`,
    [context.orgId, context.propertyId],
  );

  return result.rows.map((row) => ({
    articleVersionId: row.article_version_id,
    articleId: row.article_id,
    versionNo: row.version_no,
    isCurrent: row.is_current,
    status: row.status ?? "unreviewed",
    requestedAt: row.requested_at,
    reviewerUserId: row.reviewer_user_id,
    decidedAt: row.decided_at,
  }));
}

const DECISION_AUDIT = {
  approved: "article.version_approved",
  rejected: "article.version_rejected",
} as const;

async function decideVersion(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  articleVersionId: string,
  status: "approved" | "rejected",
): Promise<ReviewDecision> {
  // S02-06: the guard runs BEFORE the first query, so a denied caller leaves
  // no trace in the database (no audit row, no review row, no version read).
  session.requireRole("knowledge", "write");
  assertTenantShape(context);
  assertUuid(articleVersionId, "articleVersionId");

  const version = await client.query<{ version_no: number }>(
    `SELECT version_no
       FROM article_versions
      WHERE org_id = $1 AND property_id = $2 AND article_version_id = $3`,
    [context.orgId, context.propertyId, articleVersionId],
  );
  const row = version.rows[0];
  if (row === undefined) throw new ReviewNotFoundError(articleVersionId);

  // One decision per version. A re-decision moves reviewer and timestamp
  // together, so the row never claims an old reviewer made a new call.
  await client.query(
    `INSERT INTO article_reviews
       (org_id, property_id, article_version_id, status, reviewer_user_id, decided_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (property_id, article_version_id) DO UPDATE
        SET status = EXCLUDED.status,
            reviewer_user_id = EXCLUDED.reviewer_user_id,
            decided_at = EXCLUDED.decided_at`,
    [context.orgId, context.propertyId, articleVersionId, status, session.userUuid],
  );

  // Detail carries the version number and the decision only — never body text.
  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: session.userUuid,
    action: DECISION_AUDIT[status],
    entityType: "article_version",
    entityId: articleVersionId,
    detail: { version_no: row.version_no, status },
  });

  return { articleVersionId, versionNo: row.version_no, status };
}

/** Approve a version: AC-1's approval row, naming the staff member who did it. */
export function approveVersion(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  articleVersionId: string,
): Promise<ReviewDecision> {
  return decideVersion(client, context, session, articleVersionId, "approved");
}

export function rejectVersion(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  articleVersionId: string,
): Promise<ReviewDecision> {
  return decideVersion(client, context, session, articleVersionId, "rejected");
}

/**
 * The AC itself: "a contradictory pair is blocked until a human resolves it."
 *
 * One transaction, three steps: re-read the live queue (so a group that changed
 * or was already resolved is refused rather than resolved twice), verify the
 * ONE winner, then record the resolution — which is what removes the group
 * from `listContradictions`. The losers are left unverified: they were never
 * answerable (AC-2 of S03-03) and demoting them would rewrite provenance
 * (D5's source_article_version_id) for no gain.
 */
export async function resolveContradiction(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  input: ResolveContradictionInput,
): Promise<ContradictionResolution> {
  session.requireRole("knowledge", "write");
  assertTenantShape(context);

  const topicKey = validateFactKey(input.topicKey, "topicKey");
  const factKey = validateFactKey(input.factKey, "factKey");
  const language = validateFactLanguage(input.language);
  const effectiveFrom =
    input.effectiveFrom === null ? null : validateEffectiveFrom(input.effectiveFrom, "effectiveFrom");
  assertUuid(input.winnerFactId, "winnerFactId");

  const key = groupKey({ topicKey, factKey, language, effectiveFrom });
  const groups = await listContradictions(client, context);
  const group = groups.find(
    (candidate) =>
      candidate.topicKey === topicKey &&
      candidate.factKey === factKey &&
      candidate.language === language &&
      (candidate.effectiveFrom ?? null) === effectiveFrom,
  );
  if (group === undefined) throw new ContradictionGroupNotFoundError(key);

  const winner = group.entries.find((entry) => entry.factId === input.winnerFactId);
  if (winner === undefined) throw new ContradictionWinnerError(input.winnerFactId, key);

  // Exactly one verified value survives: verifyFact refuses a second one for
  // the same key + effective date (and 0009's partial unique index backs it).
  await verifyFact(client, context, { userId: session.userUuid }, input.winnerFactId);

  await client.query(
    `INSERT INTO fact_resolutions
       (org_id, property_id, topic_key, fact_key, language, effective_from,
        winner_fact_id, resolved_by, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, now())
     ON CONFLICT (property_id, topic_key, fact_key, language, effective_from)
        DO UPDATE
        SET winner_fact_id = EXCLUDED.winner_fact_id,
            resolved_by = EXCLUDED.resolved_by,
            resolved_at = EXCLUDED.resolved_at`,
    [
      context.orgId,
      context.propertyId,
      topicKey,
      factKey,
      language,
      effectiveFrom,
      input.winnerFactId,
      session.userUuid,
    ],
  );

  const demotedFactIds = group.entries
    .filter((entry) => entry.factId !== input.winnerFactId)
    .map((entry) => entry.factId);

  // Group key and winner only: fact VALUES are business data, not log detail.
  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: session.userUuid,
    action: "fact.contradiction_resolved",
    entityType: "fact_group",
    entityId: input.winnerFactId,
    detail: {
      topic_key: topicKey,
      fact_key: factKey,
      language,
      effective_from: effectiveFrom,
      winner_fact_id: input.winnerFactId,
      demoted_fact_ids: demotedFactIds,
    },
  });

  return { topicKey, factKey, language, effectiveFrom, winnerFactId: input.winnerFactId, demotedFactIds };
}
