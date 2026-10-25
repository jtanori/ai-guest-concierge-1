/**
 * S03-03 - tenant-scoped deterministic facts: lookup, not generation.
 *
 * Hours and prices are data. `lookupFact` answers from ONE verified row with
 * an exact key, and returns null when there is no such row - it never embeds,
 * ranks, calls a model or falls back to prose. That is the AC ("Pool hours
 * answered by lookup, not generation") and the reason the guest path can be
 * trusted for a closing time.
 *
 * The other half is refusing to lie: `verifyFact` will not set `verified` on
 * a value that contradicts an already-verified value for the same
 * (topic_key, fact_key, language, effective_from), so at most one value per
 * key and effective date can ever be returned. Contradictions that no human
 * has ruled on stay visible through `listContradictions` (G1's "zero
 * unresolved contradictions" queue; the resolution screen is S04-01).
 *
 * The caller supplies the tenant transaction (`withTenant` / a staff session).
 * Like S03-01, these services take `actor` for audit and do NOT call
 * `requireRole`: S04-01's route owns the guard and closes S02-06.
 */
import type pg from "pg";
import { writeAudit } from "../audit/write.ts";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";

export const FACT_UNITS = [
  "text",
  "time-of-day",
  "hours",
  "currency-amount",
  "duration",
  "distance",
  "count",
] as const;
export type FactUnit = (typeof FACT_UNITS)[number];

export const FACT_LIMITS = {
  key: 120,
  value: 500,
} as const;

export interface FactInput {
  topicKey: string;
  factKey: string;
  value: string;
  unit: FactUnit;
  language: string;
  /** YYYY-MM-DD - the date this value takes effect. */
  effectiveFrom: string;
  sourceArticleVersionId?: string | null;
}

export interface FactSummary {
  factId: string;
  topicKey: string;
  factKey: string;
  value: string;
  unit: FactUnit;
  language: string;
  effectiveFrom: string | null;
  verified: boolean;
  sourceArticleVersionId: string | null;
  createdAt: Date;
}

export interface FactDetail extends FactSummary {
  sourceId: string | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
}

export interface FactLookupInput {
  topicKey: string;
  factKey: string;
  language: string;
  /** Only facts effective on or before this date count. Defaults to today. */
  on?: string;
}

export interface FactLookupResult {
  value: string;
  unit: FactUnit;
  effectiveFrom: string;
}

export interface ContradictionEntry {
  factId: string;
  value: string;
  verified: boolean;
  sourceArticleVersionId: string | null;
}

export interface Contradiction {
  topicKey: string;
  factKey: string;
  language: string;
  effectiveFrom: string | null;
  entries: ContradictionEntry[];
}

export class FactValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(field ? `${field}: ${message}` : message);
    this.name = "FactValidationError";
    this.field = field;
  }
}

export class FactNotFoundError extends Error {
  constructor(factId: string) {
    super(`fact ${factId} was not found in this tenant (or does not exist)`);
    this.name = "FactNotFoundError";
  }
}

export class FactSourceVersionNotFoundError extends Error {
  constructor(articleVersionId: string) {
    super(
      `article_version ${articleVersionId} was not found in this tenant (or does not exist)`,
    );
    this.name = "FactSourceVersionNotFoundError";
  }
}

/** A second verified value for the same key + effective date is refused. */
export class FactContradictionError extends Error {
  readonly factId: string;
  readonly conflictingFactId: string;
  readonly conflictingValue: string;

  constructor(factId: string, conflictingFactId: string, conflictingValue: string) {
    super(
      `fact ${factId} cannot be verified: verified fact ${conflictingFactId} ` +
        `already holds this key and effective date ("${conflictingValue}"); ` +
        `a human must resolve it`,
    );
    this.name = "FactContradictionError";
    this.factId = factId;
    this.conflictingFactId = conflictingFactId;
    this.conflictingValue = conflictingValue;
  }
}

export class FactActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactActorError";
  }
}

export class FactVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactVerificationError";
  }
}

const KEY_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const LANG_RE = /^[a-z]{2,8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function fail(field: string, message: string): never {
  throw new FactValidationError(field, message);
}

/** Real calendar date, no Date parsing (Date.UTC maps years 0-99 to 19xx). */
export function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const max = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day <= max;
}

export function validateFactKey(value: unknown, field: "topicKey" | "factKey"): string {
  if (typeof value !== "string") fail(field, "must be a string");
  const key = value.trim();
  if (key.length === 0) fail(field, "must be a non-empty string");
  if (key.length > FACT_LIMITS.key) {
    fail(field, `must be at most ${FACT_LIMITS.key} characters`);
  }
  if (!KEY_RE.test(key)) {
    fail(field, "must be lowercase dot/underscore/dash-separated segments");
  }
  return key;
}

export function validateFactValue(value: unknown): string {
  if (typeof value !== "string") fail("value", "must be a string");
  const trimmed = value.trim();
  if (trimmed.length === 0) fail("value", "must be a non-empty string");
  if (trimmed.length > FACT_LIMITS.value) {
    fail("value", `must be at most ${FACT_LIMITS.value} characters`);
  }
  if (trimmed.includes("\u0000")) fail("value", "must not contain NUL characters");
  return trimmed;
}

export function validateFactUnit(value: unknown): FactUnit {
  if (typeof value !== "string") fail("unit", "must be a string");
  if (!(FACT_UNITS as readonly string[]).includes(value)) {
    fail("unit", `must be one of ${FACT_UNITS.join(" | ")}`);
  }
  return value as FactUnit;
}

export function validateFactLanguage(value: unknown): string {
  if (typeof value !== "string") fail("language", "must be a string");
  const language = value.trim().toLowerCase();
  if (!LANG_RE.test(language)) {
    fail("language", "must be 2-8 lowercase letters");
  }
  return language;
}

export function validateEffectiveFrom(value: unknown, field = "effectiveFrom"): string {
  if (typeof value !== "string") fail(field, "must be a string");
  const date = value.trim();
  if (!isRealDate(date)) fail(field, "must be a real date in YYYY-MM-DD form");
  return date;
}

export function validateSourceArticleVersionId(
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") fail("sourceArticleVersionId", "must be a UUID or null");
  const id = value.trim();
  if (!UUID_RE.test(id)) fail("sourceArticleVersionId", "must be a UUID or null");
  return id;
}

/** Normalizes and validates a whole fact document. */
export function validateFactInput(input: FactInput): FactInput {
  if (typeof input !== "object" || input === null) {
    fail("", "input must be an object");
  }
  return {
    topicKey: validateFactKey(input.topicKey, "topicKey"),
    factKey: validateFactKey(input.factKey, "factKey"),
    value: validateFactValue(input.value),
    unit: validateFactUnit(input.unit),
    language: validateFactLanguage(input.language),
    effectiveFrom: validateEffectiveFrom(input.effectiveFrom),
    sourceArticleVersionId: validateSourceArticleVersionId(input.sourceArticleVersionId),
  };
}

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) fail(field, "must be a UUID");
}

/**
 * AC-3: verification is always attributable. create/update deliberately do
 * NOT pre-check the actor - `writeAudit` is their validator and a failure
 * there rolls the whole unit back (the S03-01 pattern) - but verification is
 * a state change that must never land without an actor, so it refuses first.
 */
function assertActor(actor: { userId: string } | null | undefined): string {
  if (actor === null || actor === undefined) {
    throw new FactActorError("verifyFact requires an actor");
  }
  if (typeof actor.userId !== "string" || !UUID_RE.test(actor.userId)) {
    throw new FactActorError("verifyFact requires an actor with a UUID userId");
  }
  return actor.userId;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23503"
  );
}

async function assertSourceVersionVisible(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleVersionId: string,
): Promise<void> {
  const found = await client.query(
    `SELECT 1
       FROM article_versions
      WHERE org_id = $1 AND property_id = $2 AND article_version_id = $3`,
    [context.orgId, context.propertyId, articleVersionId],
  );
  if (found.rowCount !== 1) {
    throw new FactSourceVersionNotFoundError(articleVersionId);
  }
}

function factDetail(input: FactInput) {
  return {
    topic_key: input.topicKey,
    fact_key: input.factKey,
    unit: input.unit,
    language: input.language,
    effective_from: input.effectiveFrom,
  };
}

/* ---------- the statements, exported so their shape can be asserted ---------- */

/**
 * AC-1 in code: a single SELECT over property_facts. No write clause, no
 * embedding column, no ranking expression, no provider - `tests/knowledge/
 * facts.test.ts` asserts exactly that, because "answered by lookup" has to be
 * provable without a database.
 */
export const FACT_LOOKUP_SQL = `
  SELECT fact_value,
         unit,
         to_char(effective_from, 'YYYY-MM-DD') AS effective_from
    FROM property_facts
   WHERE org_id = $1
     AND property_id = $2
     AND topic_key = $3
     AND fact_key = $4
     AND language = $5
     AND verified
     AND effective_from <= COALESCE($6::date, CURRENT_DATE)
   ORDER BY effective_from DESC, created_at DESC
   LIMIT 1
`;

/** Groups are matched with IS NOT DISTINCT FROM so a NULL effective date works. */
export const FACT_CONTRADICTIONS_SQL = `
  WITH groups AS (
    SELECT topic_key, fact_key, language, effective_from
      FROM property_facts
     WHERE org_id = $1
       AND property_id = $2
     GROUP BY 1, 2, 3, 4
    HAVING count(DISTINCT fact_value) > 1
  )
  SELECT f.topic_key,
         f.fact_key,
         f.language,
         to_char(f.effective_from, 'YYYY-MM-DD') AS effective_from,
         f.fact_id,
         f.fact_value,
         f.verified,
         f.source_article_version_id
    FROM property_facts f
    JOIN groups g
      ON g.topic_key = f.topic_key
     AND g.fact_key = f.fact_key
     AND g.language = f.language
     AND g.effective_from IS NOT DISTINCT FROM f.effective_from
   WHERE f.org_id = $1
     AND f.property_id = $2
   ORDER BY f.topic_key, f.fact_key, f.language, f.effective_from, f.fact_id
`;

/* ---------- writes ---------- */

export async function createFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  input: FactInput,
): Promise<{ factId: string }> {
  assertTenantShape(context);
  const valid = validateFactInput(input);
  const sourceVersionId = valid.sourceArticleVersionId ?? null;
  if (sourceVersionId !== null) {
    await assertSourceVersionVisible(client, context, sourceVersionId);
  }

  const inserted = await client.query<{ fact_id: string }>(
    `INSERT INTO property_facts
       (org_id, property_id, topic_key, fact_key, fact_value, language,
        unit, effective_from, source_article_version_id, verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
     RETURNING fact_id`,
    [
      context.orgId,
      context.propertyId,
      valid.topicKey,
      valid.factKey,
      valid.value,
      valid.language,
      valid.unit,
      valid.effectiveFrom,
      sourceVersionId,
    ],
  );
  const factId = inserted.rows[0]!.fact_id;

  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: actor.userId,
    action: "fact.created",
    entityType: "fact",
    entityId: factId,
    detail: factDetail(valid),
  });
  return { factId };
}

interface FactRow {
  fact_id: string;
  topic_key: string;
  fact_key: string;
  fact_value: string;
  unit: string;
  language: string;
  effective_from: Date | null;
  source_article_version_id: string | null;
  source_id: string | null;
  verified: boolean;
  verified_by: string | null;
  verified_at: Date | null;
  created_at: Date;
}

function toSummary(row: FactRow): FactSummary {
  return {
    factId: row.fact_id,
    topicKey: row.topic_key,
    factKey: row.fact_key,
    value: row.fact_value,
    unit: row.unit as FactUnit,
    language: row.language,
    effectiveFrom: row.effective_from === null ? null : toIsoDate(row.effective_from),
    verified: row.verified,
    sourceArticleVersionId: row.source_article_version_id,
    createdAt: row.created_at,
  };
}

function toDetail(row: FactRow): FactDetail {
  return {
    ...toSummary(row),
    sourceId: row.source_id,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
  };
}

/** `date` columns parse to a local-midnight Date; go back to YYYY-MM-DD. */
function toIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const FACT_COLUMNS = `fact_id, topic_key, fact_key, fact_value, unit, language,
        effective_from, source_article_version_id, source_id, verified,
        verified_by, verified_at, created_at`;

export async function updateFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  factId: string,
  input: FactInput,
): Promise<{ factId: string; verifiedReset: boolean }> {
  assertTenantShape(context);
  assertUuid(factId, "factId");
  const valid = validateFactInput(input);
  const sourceVersionId = valid.sourceArticleVersionId ?? null;
  if (sourceVersionId !== null) {
    await assertSourceVersionVisible(client, context, sourceVersionId);
  }

  const locked = await client.query<FactRow>(
    `SELECT ${FACT_COLUMNS}
       FROM property_facts
      WHERE org_id = $1 AND property_id = $2 AND fact_id = $3
      FOR UPDATE`,
    [context.orgId, context.propertyId, factId],
  );
  const before = locked.rows[0];
  if (before === undefined) throw new FactNotFoundError(factId);

  await client.query(
    `UPDATE property_facts
        SET topic_key = $1,
            fact_key = $2,
            fact_value = $3,
            language = $4,
            unit = $5,
            effective_from = $6,
            source_article_version_id = $7,
            verified = false,
            verified_by = NULL,
            verified_at = NULL
      WHERE org_id = $8 AND property_id = $9 AND fact_id = $10`,
    [
      valid.topicKey,
      valid.factKey,
      valid.value,
      valid.language,
      valid.unit,
      valid.effectiveFrom,
      sourceVersionId,
      context.orgId,
      context.propertyId,
      factId,
    ],
  );

  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: actor.userId,
    action: "fact.updated",
    entityType: "fact",
    entityId: factId,
    detail: factDetail(valid),
  });

  return { factId, verifiedReset: before.verified };
}

export async function listFacts(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<FactSummary[]> {
  assertTenantShape(context);
  const result = await client.query<FactRow>(
    `SELECT ${FACT_COLUMNS}
       FROM property_facts
      WHERE org_id = $1 AND property_id = $2
      ORDER BY topic_key, fact_key, language, effective_from, fact_id`,
    [context.orgId, context.propertyId],
  );

  return result.rows.map((row) => toSummary(row));
}

export async function getFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  factId: string,
): Promise<FactDetail> {
  assertTenantShape(context);
  assertUuid(factId, "factId");
  const result = await client.query<FactRow>(
    `SELECT ${FACT_COLUMNS}
       FROM property_facts
      WHERE org_id = $1 AND property_id = $2 AND fact_id = $3`,
    [context.orgId, context.propertyId, factId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FactNotFoundError(factId);
  return toDetail(row);
}

export async function verifyFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  factId: string,
): Promise<{ factId: string }> {
  assertTenantShape(context);
  const userId = assertActor(actor);
  assertUuid(factId, "factId");

  // Read the key first (no lock): it tells us which group to lock.
  const keyResult = await client.query<{
    topic_key: string;
    fact_key: string;
    fact_value: string;
    unit: string;
    language: string;
    effective_from: Date | null;
  }>(
    `SELECT topic_key, fact_key, fact_value, unit, language, effective_from
       FROM property_facts
      WHERE org_id = $1 AND property_id = $2 AND fact_id = $3`,
    [context.orgId, context.propertyId, factId],
  );
  const key = keyResult.rows[0];
  if (key === undefined) throw new FactNotFoundError(factId);
  if (key.effective_from === null) {
    throw new FactVerificationError(
      `fact ${factId} has no effective_from date; set one before verifying`,
    );
  }

  const effectiveFrom = toIsoDate(key.effective_from);

  // Lock the whole key group in a deterministic order: two verifiers of the
  // same key then serialise on the same rows in the same order, so the
  // contradiction check below cannot race (and cannot deadlock).
  const group = await client.query<{
    fact_id: string;
    fact_value: string;
    verified: boolean;
  }>(
    `SELECT fact_id, fact_value, verified
       FROM property_facts
      WHERE org_id = $1
        AND property_id = $2
        AND topic_key = $3
        AND fact_key = $4
        AND language = $5
        AND effective_from = $6::date
      ORDER BY fact_id
        FOR UPDATE`,
    [
      context.orgId,
      context.propertyId,
      key.topic_key,
      key.fact_key,
      key.language,
      effectiveFrom,
    ],
  );
  if (!group.rows.some((row) => row.fact_id === factId)) {
    // The row changed key while we were reading it - refuse rather than
    // verify something we have not inspected.
    throw new FactVerificationError(
      `fact ${factId} changed while verification was in progress; retry`,
    );
  }

  // One verified row per key + effective date (the partial index says so);
  // when it is a different value that is the contradiction G1 tracks, when it
  // is the same value the key is simply already held. Unverified
  // disagreements are neither: they answer nothing (AC-2) and stay in the
  // contradiction queue for S04-01.
  const clash = group.rows.find(
    (row) => row.fact_id !== factId && row.verified,
  );
  if (clash !== undefined) {
    throw new FactContradictionError(factId, clash.fact_id, clash.fact_value);
  }

  try {
    await client.query(
      `UPDATE property_facts
          SET verified = true,
              verified_by = $1,
              verified_at = now()
        WHERE org_id = $2 AND property_id = $3 AND fact_id = $4`,
      [userId, context.orgId, context.propertyId, factId],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await client.query<{ fact_id: string; fact_value: string }>(
        `SELECT fact_id, fact_value
           FROM property_facts
          WHERE org_id = $1 AND property_id = $2
            AND topic_key = $3 AND fact_key = $4 AND language = $5
            AND effective_from = $6::date
            AND verified AND fact_id <> $7`,
        [
          context.orgId,
          context.propertyId,
          key.topic_key,
          key.fact_key,
          key.language,
          effectiveFrom,
          factId,
        ],
      );
      const conflicting = winner.rows[0];
      throw new FactContradictionError(
        factId,
        conflicting?.fact_id ?? "unknown",
        conflicting?.fact_value ?? "unknown",
      );
    }
    if (isForeignKeyViolation(error)) {
      throw new FactActorError(`actor ${userId} is not a known user`);
    }
    throw error;
  }

  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: userId,
    action: "fact.verified",
    entityType: "fact",
    entityId: factId,
    detail: {
      topic_key: key.topic_key,
      fact_key: key.fact_key,
      unit: key.unit,
      language: key.language,
      effective_from: effectiveFrom,
      value: key.fact_value,
    },
  });

  return { factId };
}

export async function lookupFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: FactLookupInput,
): Promise<FactLookupResult | null> {
  assertTenantShape(context);
  if (typeof input !== "object" || input === null) {
    fail("", "input must be an object");
  }
  const topicKey = validateFactKey(input.topicKey, "topicKey");
  const factKey = validateFactKey(input.factKey, "factKey");
  const language = validateFactLanguage(input.language);
  const on =
    input.on === undefined ? null : validateEffectiveFrom(input.on, "on");

  const result = await client.query<{
    fact_value: string;
    unit: string;
    effective_from: string;
  }>(FACT_LOOKUP_SQL, [
    context.orgId,
    context.propertyId,
    topicKey,
    factKey,
    language,
    on,
  ]);

  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    value: row.fact_value,
    unit: row.unit as FactUnit,
    effectiveFrom: row.effective_from,
  };
}

export async function listContradictions(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<Contradiction[]> {
  assertTenantShape(context);
  const result = await client.query<{
    topic_key: string;
    fact_key: string;
    language: string;
    effective_from: string | null;
    fact_id: string;
    fact_value: string;
    verified: boolean;
    source_article_version_id: string | null;
  }>(FACT_CONTRADICTIONS_SQL, [context.orgId, context.propertyId]);

  const grouped = new Map<string, Contradiction>();
  for (const row of result.rows) {
    const effectiveFrom = row.effective_from;
    const id = `${row.topic_key}|${row.fact_key}|${row.language}|${effectiveFrom ?? ""}`;
    let contradiction = grouped.get(id);
    if (contradiction === undefined) {
      contradiction = {
        topicKey: row.topic_key,
        factKey: row.fact_key,
        language: row.language,
        effectiveFrom,
        entries: [],
      };
      grouped.set(id, contradiction);
    }
    contradiction.entries.push({
      factId: row.fact_id,
      value: row.fact_value,
      verified: row.verified,
      sourceArticleVersionId: row.source_article_version_id,
    });
  }
  return [...grouped.values()];
}
