/**
 * S03-01 - tenant-scoped article authoring with immutable version history.
 *
 * Every edit appends a new `article_versions` row; bodies are never rewritten
 * (0003's trigger enforces that). New versions are born retired and stay
 * retired until S04-01 publishes them through `reembedAndPublish`.
 *
 * The caller supplies the tenant transaction (`withTenant` / a staff session).
 * These services take `actor` for audit only and do NOT call `requireRole`:
 * S04-01's route owns the guard and closes S02-06.
 */
import type pg from "pg";
import { writeAudit } from "../audit/write.ts";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";

export const ARTICLE_LANGUAGES = ["es", "en"] as const;
export type ArticleLanguage = (typeof ARTICLE_LANGUAGES)[number];

export const ARTICLE_LIMITS = {
  topicKey: 120,
  title: 200,
  body: 200_000,
  preview: 160,
} as const;

export interface ArticleDraft {
  topicKey: string;
  title: string;
  body: string | null;
  language: ArticleLanguage;
  sourceId?: string | null;
}

export interface ArticleSummary {
  articleId: string;
  topicKey: string;
  title: string;
  language: string | null;
  sourceId: string | null;
  currentVersionId: string | null;
  currentVersionNo: number | null;
  versionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArticleVersionSummary {
  articleVersionId: string;
  versionNo: number;
  isCurrent: boolean;
  promotedAt: Date | null;
  createdAt: Date;
  bodyLength: number | null;
  bodyPreview: string | null;
}

export interface ArticleVersionDetail extends ArticleVersionSummary {
  articleId: string;
  topicKey: string;
  title: string;
  language: string | null;
  sourceId: string | null;
  body: string | null;
}

export class ArticleValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(field ? `${field}: ${message}` : message);
    this.name = "ArticleValidationError";
    this.field = field;
  }
}

export class ArticleTopicConflictError extends Error {
  readonly topicKey: string;

  constructor(topicKey: string) {
    super(`a property-scope article for topic "${topicKey}" already exists; edit it instead`);
    this.name = "ArticleTopicConflictError";
    this.topicKey = topicKey;
  }
}

export class ArticleNotFoundError extends Error {
  constructor(articleId: string) {
    super(`article ${articleId} was not found in this tenant (or does not exist)`);
    this.name = "ArticleNotFoundError";
  }
}

export class ArticleVersionNotFoundError extends Error {
  constructor(articleVersionId: string) {
    super(
      `article_version ${articleVersionId} was not found in this tenant (or does not exist)`,
    );
    this.name = "ArticleVersionNotFoundError";
  }
}

export class ArticleSourceNotFoundError extends Error {
  constructor(sourceId: string) {
    super(`knowledge_source ${sourceId} was not found in this tenant (or does not exist)`);
    this.name = "ArticleSourceNotFoundError";
  }
}

export class ArticleVersionConflictError extends Error {
  constructor(articleId: string) {
    super(`article ${articleId} changed while a new version was being appended; retry`);
    this.name = "ArticleVersionConflictError";
  }
}

const TOPIC_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(field: string, message: string): never {
  throw new ArticleValidationError(field, message);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export function validateTopicKey(value: unknown): string {
  if (typeof value !== "string") fail("topicKey", "must be a string");
  const topicKey = value.trim();
  if (topicKey.length === 0) fail("topicKey", "must be a non-empty string");
  if (topicKey.length > ARTICLE_LIMITS.topicKey) {
    fail("topicKey", `must be at most ${ARTICLE_LIMITS.topicKey} characters`);
  }
  if (!TOPIC_RE.test(topicKey)) {
    fail("topicKey", "must be lowercase dot/underscore/dash-separated segments");
  }
  return topicKey;
}

export function validateTitle(value: unknown): string {
  if (typeof value !== "string") fail("title", "must be a string");
  const title = value.trim();
  if (title.length === 0) fail("title", "must be a non-empty string");
  if (title.length > ARTICLE_LIMITS.title) {
    fail("title", `must be at most ${ARTICLE_LIMITS.title} characters`);
  }
  return title;
}

export function validateBody(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail("body", "must be a string or null");
  if (value.trim().length === 0) fail("body", "must not be empty (use null for a picture-only article)");
  if (value.length > ARTICLE_LIMITS.body) {
    fail("body", `must be at most ${ARTICLE_LIMITS.body} characters`);
  }
  if (value.includes("\u0000")) fail("body", "must not contain NUL characters");
  return value;
}

export function validateLanguage(value: unknown): ArticleLanguage {
  if (typeof value !== "string") fail("language", "must be a string");
  const language = value.trim().toLowerCase();
  if (!(ARTICLE_LANGUAGES as readonly string[]).includes(language)) {
    fail("language", `must be one of ${ARTICLE_LANGUAGES.join(" | ")}`);
  }
  return language as ArticleLanguage;
}

export function validateSourceId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") fail("sourceId", "must be a UUID or null");
  const sourceId = value.trim();
  if (!UUID_RE.test(sourceId)) fail("sourceId", "must be a UUID or null");
  return sourceId;
}

/**
 * Normalizes and validates a draft. `sourceId: undefined` is preserved so an
 * edit can keep the article's existing source; `null` explicitly clears it.
 */
export function validateArticleDraft(draft: ArticleDraft): ArticleDraft {
  if (typeof draft !== "object" || draft === null) {
    fail("", "draft must be an object");
  }
  return {
    topicKey: validateTopicKey(draft.topicKey),
    title: validateTitle(draft.title),
    body: validateBody(draft.body),
    language: validateLanguage(draft.language),
    sourceId: validateSourceId(draft.sourceId),
  };
}

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) fail(field, "must be a UUID");
}

async function assertSourceVisible(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  sourceId: string,
): Promise<void> {
  const found = await client.query(
    `SELECT 1
       FROM knowledge_sources
      WHERE org_id = $1 AND property_id = $2 AND source_id = $3`,
    [context.orgId, context.propertyId, sourceId],
  );
  if (found.rowCount !== 1) throw new ArticleSourceNotFoundError(sourceId);
}

function preview(body: string | null): string | null {
  if (body === null) return null;
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= ARTICLE_LIMITS.preview) return oneLine;
  return `${oneLine.slice(0, ARTICLE_LIMITS.preview - 3)}...`;
}

async function writeVersionCreated(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  draft: ArticleDraft,
  articleVersionId: string,
  versionNo: number,
): Promise<void> {
  await writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: actor.userId,
    action: "article.version_created",
    entityType: "article_version",
    entityId: articleVersionId,
    detail: {
      topic_key: draft.topicKey,
      version_no: versionNo,
      has_text: draft.body !== null,
      language: draft.language,
    },
  });
}

export async function createArticle(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  draft: ArticleDraft,
): Promise<{ articleId: string; articleVersionId: string; versionNo: number }> {
  assertTenantShape(context);
  const valid = validateArticleDraft(draft);
  const sourceId = valid.sourceId ?? null;
  if (sourceId !== null) await assertSourceVisible(client, context, sourceId);

  let articleId: string;
  try {
    const article = await client.query<{ article_id: string }>(
      `INSERT INTO knowledge_articles
         (org_id, property_id, source_id, scope, topic_key, title, language)
       VALUES ($1, $2, $3, 'property', $4, $5, $6)
       RETURNING article_id`,
      [
        context.orgId,
        context.propertyId,
        sourceId,
        valid.topicKey,
        valid.title,
        valid.language,
      ],
    );
    articleId = article.rows[0]!.article_id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ArticleTopicConflictError(valid.topicKey);
    throw error;
  }

  let articleVersionId: string;
  try {
    const version = await client.query<{ article_version_id: string }>(
      `INSERT INTO article_versions
         (org_id, property_id, article_id, version_no, body)
       VALUES ($1, $2, $3, 1, $4)
       RETURNING article_version_id`,
      [context.orgId, context.propertyId, articleId, valid.body],
    );
    articleVersionId = version.rows[0]!.article_version_id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ArticleVersionConflictError(articleId);
    throw error;
  }

  await writeVersionCreated(client, context, actor, valid, articleVersionId, 1);
  return { articleId, articleVersionId, versionNo: 1 };
}

interface LockedArticleRow {
  topic_key: string;
  title: string;
  language: string | null;
  source_id: string | null;
}

interface LatestVersionRow {
  article_version_id: string;
  version_no: number;
  body: string | null;
}

export async function editArticle(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  articleId: string,
  draft: ArticleDraft,
): Promise<{
  articleVersionId: string;
  versionNo: number;
  created: boolean;
  wrote: boolean;
}> {
  assertTenantShape(context);
  assertUuid(articleId, "articleId");
  const valid = validateArticleDraft(draft);

  const locked = await client.query<LockedArticleRow>(
    `SELECT topic_key, title, language, source_id
       FROM knowledge_articles
      WHERE org_id = $1 AND property_id = $2 AND article_id = $3 AND scope = 'property'
      FOR UPDATE`,
    [context.orgId, context.propertyId, articleId],
  );
  const article = locked.rows[0];
  if (article === undefined) throw new ArticleNotFoundError(articleId);
  if (article.topic_key !== valid.topicKey) {
    fail("topicKey", "cannot change an article's topic_key; create a new article instead");
  }

  const nextSourceId =
    valid.sourceId === undefined ? article.source_id : valid.sourceId;
  if (nextSourceId !== null && nextSourceId !== article.source_id) {
    await assertSourceVisible(client, context, nextSourceId);
  }

  const latestResult = await client.query<LatestVersionRow>(
    `SELECT article_version_id, version_no, body
       FROM article_versions
      WHERE org_id = $1 AND property_id = $2 AND article_id = $3
      ORDER BY version_no DESC
      LIMIT 1`,
    [context.orgId, context.propertyId, articleId],
  );
  const latest = latestResult.rows[0];
  if (latest === undefined) throw new ArticleNotFoundError(articleId);

  const changed: string[] = [];
  if (article.title !== valid.title) changed.push("title");
  if (article.language !== valid.language) changed.push("language");
  if (article.source_id !== nextSourceId) changed.push("source_id");

  const bodyChanged = latest.body !== valid.body;
  if (changed.length === 0 && !bodyChanged) {
    return {
      articleVersionId: latest.article_version_id,
      versionNo: latest.version_no,
      created: false,
      wrote: false,
    };
  }

  if (changed.length > 0) {
    await client.query(
      `UPDATE knowledge_articles
          SET title = $1, language = $2, source_id = $3
        WHERE org_id = $4 AND property_id = $5 AND article_id = $6`,
      [valid.title, valid.language, nextSourceId, context.orgId, context.propertyId, articleId],
    );
    await writeAudit(client, {
      orgId: context.orgId,
      propertyId: context.propertyId,
      actorUserId: actor.userId,
      action: "article.updated",
      entityType: "article",
      entityId: articleId,
      detail: { changed },
    });
  }

  if (!bodyChanged) {
    return {
      articleVersionId: latest.article_version_id,
      versionNo: latest.version_no,
      created: false,
      wrote: true,
    };
  }

  const versionNo = latest.version_no + 1;
  let articleVersionId: string;
  try {
    const version = await client.query<{ article_version_id: string }>(
      `INSERT INTO article_versions
         (org_id, property_id, article_id, version_no, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING article_version_id`,
      [context.orgId, context.propertyId, articleId, versionNo, valid.body],
    );
    articleVersionId = version.rows[0]!.article_version_id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ArticleVersionConflictError(articleId);
    throw error;
  }

  await writeVersionCreated(client, context, actor, valid, articleVersionId, versionNo);
  return { articleVersionId, versionNo, created: true, wrote: true };
}

interface ArticleListRow {
  article_id: string;
  topic_key: string;
  title: string;
  language: string | null;
  source_id: string | null;
  current_version_id: string | null;
  current_version_no: number | null;
  version_count: number;
  created_at: Date;
  updated_at: Date;
}

export async function listArticles(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<ArticleSummary[]> {
  assertTenantShape(context);
  const result = await client.query<ArticleListRow>(
    `SELECT ka.article_id,
            ka.topic_key,
            ka.title,
            ka.language,
            ka.source_id,
            cv.article_version_id AS current_version_id,
            cv.version_no AS current_version_no,
            stats.version_count,
            ka.created_at,
            COALESCE(stats.latest_created_at, ka.created_at) AS updated_at
       FROM knowledge_articles ka
       LEFT JOIN LATERAL (
         SELECT av.article_version_id, av.version_no
           FROM article_versions av
          WHERE av.org_id = ka.org_id
            AND av.property_id = ka.property_id
            AND av.article_id = ka.article_id
            AND av.is_current
          LIMIT 1
       ) cv ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS version_count,
                max(av.created_at) AS latest_created_at
           FROM article_versions av
          WHERE av.org_id = ka.org_id
            AND av.property_id = ka.property_id
            AND av.article_id = ka.article_id
       ) stats ON true
      WHERE ka.org_id = $1 AND ka.property_id = $2 AND ka.scope = 'property'
      ORDER BY ka.topic_key, ka.article_id`,
    [context.orgId, context.propertyId],
  );

  return result.rows.map((row) => ({
    articleId: row.article_id,
    topicKey: row.topic_key,
    title: row.title,
    language: row.language,
    sourceId: row.source_id,
    currentVersionId: row.current_version_id,
    currentVersionNo: row.current_version_no,
    versionCount: Number(row.version_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

interface VersionListRow {
  article_version_id: string;
  version_no: number;
  is_current: boolean;
  promoted_at: Date | null;
  created_at: Date;
  body: string | null;
}

export async function listVersions(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleId: string,
): Promise<ArticleVersionSummary[]> {
  assertTenantShape(context);
  assertUuid(articleId, "articleId");

  const article = await client.query(
    `SELECT 1
       FROM knowledge_articles
      WHERE org_id = $1 AND property_id = $2 AND article_id = $3 AND scope = 'property'`,
    [context.orgId, context.propertyId, articleId],
  );
  if (article.rowCount !== 1) throw new ArticleNotFoundError(articleId);

  const result = await client.query<VersionListRow>(
    `SELECT article_version_id, version_no, is_current, promoted_at, created_at, body
       FROM article_versions
      WHERE org_id = $1 AND property_id = $2 AND article_id = $3
      ORDER BY version_no DESC`,
    [context.orgId, context.propertyId, articleId],
  );

  return result.rows.map((row) => ({
    articleVersionId: row.article_version_id,
    versionNo: row.version_no,
    isCurrent: row.is_current,
    promotedAt: row.promoted_at,
    createdAt: row.created_at,
    bodyLength: row.body === null ? null : row.body.length,
    bodyPreview: preview(row.body),
  }));
}

interface VersionDetailRow extends VersionListRow {
  article_id: string;
  topic_key: string;
  title: string;
  language: string | null;
  source_id: string | null;
}

export async function getVersion(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleVersionId: string,
): Promise<ArticleVersionDetail> {
  assertTenantShape(context);
  assertUuid(articleVersionId, "articleVersionId");

  const result = await client.query<VersionDetailRow>(
    `SELECT av.article_version_id,
            av.article_id,
            av.version_no,
            av.is_current,
            av.promoted_at,
            av.created_at,
            av.body,
            ka.topic_key,
            ka.title,
            ka.language,
            ka.source_id
       FROM article_versions av
       JOIN knowledge_articles ka
         ON ka.article_id = av.article_id
        AND ka.org_id = av.org_id
        AND ka.property_id = av.property_id
      WHERE av.org_id = $1
        AND av.property_id = $2
        AND av.article_version_id = $3
        AND ka.scope = 'property'`,
    [context.orgId, context.propertyId, articleVersionId],
  );

  const row = result.rows[0];
  if (row === undefined) throw new ArticleVersionNotFoundError(articleVersionId);

  return {
    articleVersionId: row.article_version_id,
    articleId: row.article_id,
    topicKey: row.topic_key,
    title: row.title,
    language: row.language,
    sourceId: row.source_id,
    versionNo: row.version_no,
    isCurrent: row.is_current,
    promotedAt: row.promoted_at,
    createdAt: row.created_at,
    bodyLength: row.body === null ? null : row.body.length,
    bodyPreview: preview(row.body),
    body: row.body,
  };
}
