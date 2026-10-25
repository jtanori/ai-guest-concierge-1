---
id: S03-01
title: Article editor + immutable versioning
sprint: S03
epic: S03 - Knowledge
track: Knowledge
estimate_days: 2.0
priority: P0
depends_on: [S01-01]
labels: [sprint:S03, track:foundation, prio:P0]
milestone: S03 - Knowledge
---

# S03-01 - Article editor + immutable versioning

## 1. Why

The content system starts here. `knowledge_articles` is the editable identity
(topic, title, language, scope) and `article_versions` is the immutable
history (body, version number, embedding, current marker). The schema and its
append-only trigger already exist; there is no service that creates or edits
content yet.

The backlog AC is "Editing never alters a historical version". That is a
write-path property: an edit must INSERT a new `article_versions` row, never
UPDATE body/title/version_no on an old one. Publishing is deliberately not in
this item - S04-01 owns review-and-approve and calls S02-05's
`reembedAndPublish`.

## 2. Goal

A tenant-scoped article service that creates articles and edits them by
appending versions. History stays byte-for-byte selectable, and no API path
can rewrite it. No browser UI and no HTTP route in this item.

## 3. Acceptance criteria

**Backlog AC (verbatim):** Editing never alters a historical version.

- **AC-1** `createArticle` inserts one `knowledge_articles` row and one
  retired `article_versions` row (`version_no = 1`, `is_current = false`,
  `promoted_at = NULL`). It never publishes.
- **AC-2** `editArticle` appends `version_no = max + 1` and leaves every
  earlier version row unchanged (body, title snapshot fields, version_no,
  `promoted_at`, embedding, `created_at`).
- **AC-3** A historical version remains selectable by `article_version_id`
  under the same tenant context, including after later edits.
- **AC-4** Saving identical content is a no-op: no new version, no audit row,
  and the existing current/latest version id is returned.
- **AC-5** A foreign-tenant article id or version id behaves exactly like an
  unknown id (typed not-found, no existence leak); all reads/writes are
  RLS-scoped.
- **AC-6** Creating a version and changing article metadata each write an
  audit row with no article body in `detail`; a failed write rolls the audit
  row back with it.

## 4. Scope

**In:** `src/knowledge/articles.ts` (create/edit/list/get/versions),
validation helpers, typed errors, audit call sites, unit tests and
`tests/db/articles.db.test.ts`.

**Out:** publishing/promotion (S04-01), review queue (S04-01), chunking and
embeddings (S04-02), CSV import (S03-02), browser UI/HTTP routes (S08 staff
inbox; S04-01 is the first route), brand-scope inheritance (S04/S05), article
archival, rich text/HTML sanitisation, image upload.

## 5. Design

### 5.1 Module and signatures

```ts
export interface ArticleDraft {
  topicKey: string;              // e.g. "pool.hours"
  title: string;
  body: string | null;           // null = picture-only / no extractable text
  language: "es" | "en";
  sourceId?: string | null;
}

export async function createArticle(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  draft: ArticleDraft,
): Promise<{ articleId: string; articleVersionId: string; versionNo: number }>;

export async function editArticle(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  articleId: string,
  draft: ArticleDraft,
): Promise<{ articleVersionId: string; versionNo: number; created: boolean }>;

export async function listArticles(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<ArticleSummary[]>;

export async function listVersions(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleId: string,
): Promise<ArticleVersionSummary[]>;

export async function getVersion(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  articleVersionId: string,
): Promise<ArticleVersionDetail>;
```

Services assume the caller is already inside `withTenant` / `withStaffSession`
(the S02-02 store pattern). They take `actor` for audit only and do **not**
call `requireRole`: the first production route is S04-01, which wires the
guard and closes S02-06. This keeps the S02-06 decision intact.

### 5.2 Create

- `scope` is always `property` in S03-01; brand rows remain seed/fixture only.
- INSERT `knowledge_articles` (`topic_key`, `title`, `language`, `scope`,
  `source_id`) then INSERT version 1 with `is_current = false` and
  `promoted_at = NULL`.
- `source_id` is optional and must resolve inside the tenant; the composite FK
  enforces it.
- A duplicate `(topic_key, scope, property_id)` surfaces as
  `ArticleTopicConflictError` (23505), not a raw driver error.

### 5.3 Edit and version numbering

1. `SELECT article_id FROM knowledge_articles WHERE article_id = $1 FOR UPDATE`
   - row lock serialises concurrent edits of the same article.
2. Read the latest version and the article metadata.
3. If `body`, `title` and `language` are all unchanged, return the latest
   version with `created: false` and write nothing.
4. If title/language changed, UPDATE only `knowledge_articles.title` /
   `language`; write `article.updated` with `{changed: [...]}`.
5. If body changed, INSERT a new `article_versions` row with
   `version_no = (SELECT max(version_no) + 1 ...)`, `is_current = false`,
   `promoted_at = NULL`, and no embedding; write `article.version_created`.
6. The old version is never UPDATEd. 0003's trigger remains the enforcement
   if a future caller tries.

`title` and `language` live on the article, not the version; they are
article metadata and may change. The AC covers the immutable version row
(body/version_no/promoted_at/embedding/created_at), not article metadata.

### 5.4 Validation

- `topicKey`: 1..120 chars, lowercase segments separated by dots
  (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`); reject whitespace/uppercase.
- `title`: trimmed, 1..200 chars.
- `body`: `null` or a string; an empty/whitespace-only string is refused.
  Maximum 200,000 characters. Body is stored verbatim (no trim) so an edit
  can be byte-compared.
- `language`: exactly `es` or `en`.
- `sourceId`: UUID when present.
- Validation throws `ArticleValidationError` with a field path.

### 5.5 Reads

- `listArticles` returns article metadata plus the current version id/no when
  one exists; newest topic first is not assumed - order by `topic_key`.
- `listVersions` returns newest first (`version_no DESC`) with `isCurrent`,
  `promotedAt`, `createdAt` and body length only.
- `getVersion` returns the full body for the editor/history view.
- All reads use the caller's tenant transaction; no direct SQL outside this
  module.

### 5.6 Audit

Add two actions to `src/audit/actions.ts`:

- `article.version_created` - entity `article_version`, detail
  `{article_id, version_no, topic_key, scope, language}`.
- `article.updated` - entity `article`, detail `{changed}` where `changed` is
  a subset of `["title", "language"]`.

Never put `body`, `content` or HTML in `detail`; the S02-03 guard rejects
those keys. Audit is written in the same transaction as the mutation.

## 6. Tenancy and security

- `withTenant` / `withStaffSession` supplies the GUCs; RLS scopes every
  SELECT/INSERT/UPDATE.
- Foreign ids return `ArticleNotFoundError` / `ArticleVersionNotFoundError`;
  no existence leak.
- `actor.userId` is a UUID from the resolved session; the service does not
  trust a role from the request body. Authorization is the future route's job
  (S04-01), not this module's.
- Body text is hotel content, not guest PII; it must still never enter audit
  detail or logs.

## 7. Test plan

Unit - `tests/knowledge/articles.test.ts`:
- topic/title/body/language validation accepts good values and rejects
  uppercase topics, empty title, empty body, >200k body, wrong language.
- `ArticleDraft` accepts `body: null` (noticeboard) and rejects `""`.

DB - `tests/db/articles.db.test.ts`:
- create -> one article + v1 retired; no current row; audit row exists.
- edit -> v2 retired; v1 row is byte-identical (including `created_at` and
  `promoted_at`) and still selectable by id; audit row exists.
- no-op edit -> no v3, no new audit row.
- title-only edit -> article title changes, no new version, `article.updated`
  audit.
- duplicate topic -> `ArticleTopicConflictError`; no second article.
- property-B context on a property-A article/version -> not found; RLS.
- direct UPDATE of an old version body is still refused by 0003 (regression
  proof, run as owner).
- failed audit insert rolls the new version back.

## 8. Evidence

```text
$ npm test                 # unit validation + existing suites
$ npm run db:test          # articles suite + existing suites
$ npm run typecheck && npm run lint && npm run build
```

Runbook S03-01 records the AC test names (history byte-identical, no-op save,
foreign id not found) and counts.

## 9. Risks and open questions

- **Title is not versioned.** The schema stores title/language on the article;
  historical citations show current metadata. This is accepted for MVP; a
  future version-title snapshot is a schema change.
- **No publish in this item.** A created/edited version stays retired until
  S04-01's review-and-approve calls `reembedAndPublish`.
- **No UI/route.** API/service-first per the 2026-10-24 decision; S08 owns the
  staff UI. S02-06 stays open until S04-01.
- **Body size cap 200k** is a guardrail, not a product limit; revisit if a
  real hotel sends larger manuals.

## 10. Definition of done

- [ ] Create/edit/list/get/versions implemented with typed errors.
- [ ] AC-2 history-byte-identity and AC-4 no-op proven in the DB suite.
- [ ] Audit actions added and tested; no body in detail.
- [ ] No schema change; no new dependency; no HTTP route.
- [ ] Runbook entry with evidence; workbook tick after merge.
- [ ] Review threads resolved; S04-01 wiring note recorded.
