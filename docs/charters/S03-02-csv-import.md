---
id: S03-02
title: CSV bulk import with preview
sprint: S03
epic: S03 - Knowledge
track: Knowledge
estimate_days: 1.0
priority: P0
depends_on: [S03-01]
labels: [sprint:S03, track:foundation, prio:P0]
milestone: S03 - Knowledge
---

# S03-02 - CSV bulk import with preview

## 1. Why

The first five hotels onboard with assisted content entry. A paste-in article
service exists after S03-01, but a content owner with 25-40 articles needs a
bulk path. The plan explicitly chooses CSV import over PDF/website extraction:
it is deterministic, reviewable and removes 5-8 dev-days from the critical
path.

The backlog AC is "A 100-row CSV imports with a preview step and no silent
failures". The failure mode to prevent is a partial import that leaves the
hotel unsure which rows landed.

## 2. Goal

A pure preview function that reports every row-level problem without writing,
and an all-or-nothing import that revalidates and writes through S03-01's
article service. No browser UI, no new dependency, no silent row drops.

## 3. Acceptance criteria

**Backlog AC (verbatim):** A 100-row CSV imports with a preview step and no
silent failures.

- **AC-1** A valid 100-row CSV previews 100 rows and imports exactly 100
  articles + 100 versions (or 100 new versions when the topics already exist).
- **AC-2** Preview is read-only: malformed rows, missing headers, duplicate
  topics and invalid fields are reported with row/field/message; the DB is
  untouched.
- **AC-3** Import re-runs validation and refuses the whole file if any error
  remains; it never writes a valid prefix and never silently skips a row.
- **AC-4** Quoted commas, escaped quotes, embedded newlines and a UTF-8 BOM
  parse correctly; an unclosed quote is a typed parse error, not a silent
  truncation.
- **AC-5** A topic already present in the tenant becomes a new version via
  S03-01; a new topic becomes an article + version 1. No duplicate articles
  are created.
- **AC-6** Import runs under the caller's tenant transaction; RLS and S03-01's
  audit rows apply to every row. A DB failure rolls the entire file back.

## 4. Scope

**In:** `src/knowledge/csv.ts` (parser + preview), `src/knowledge/import.ts`
(commit), typed errors, unit tests and `tests/db/import.db.test.ts`.

**Out:** browser UI/upload endpoint (S08), PDF/web/OCR extraction (MVP-1.5),
partial imports, resumable imports, background jobs, formula/CSV-injection
sanitisation (export concern), brand-scope rows, publishing (S04-01), chunking
and embeddings (S04-02).

## 5. Design

### 5.1 CSV contract

Required header, exact names, case-insensitive after trim:

```text
topic_key,title,language,body
```

Optional `source_id` (UUID) may be added later; not in v1. `scope` is always
`property`. Header order is fixed but extra unknown headers are an error
(closed contract, no silent typos).

- UTF-8, optional BOM, `\n` or `\r\n`.
- RFC 4180-style quoting: `"a,b"`, `""` inside quotes, newlines inside
  quotes.
- Empty file, missing/duplicate/unknown headers, a row with the wrong column
  count, or >500 rows are errors.
- `body` may contain newlines when quoted; `body` may not be empty.
- `language` is `es` or `en`.
- `topic_key`, `title` and `body` validation is delegated to S03-01's exported
  validators so preview and commit cannot drift.

### 5.2 Preview

```ts
export interface CsvRowError {
  row: number;                 // 1-based data row, excluding header
  field: string;
  message: string;
}
export interface CsvPreviewRow {
  row: number;
  draft: ArticleDraft;
}
export interface CsvPreview {
  rows: CsvPreviewRow[];
  errors: CsvRowError[];
  counts: { total: number; valid: number; invalid: number };
}
export function previewArticleCsv(text: string): CsvPreview;
```

- Pure, no DB, no I/O.
- Reports **every** error it can, not just the first; a row with several bad
  fields yields several `CsvRowError`s.
- Duplicate `topic_key` values inside one file are errors on the later row
  (the file is ambiguous; the import must not guess create-vs-edit).
- `rows` contains only valid drafts; `errors` is empty iff the whole file is
  valid.

### 5.3 Commit

```ts
export async function importArticleCsv(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  text: string,
): Promise<{ imported: number; created: number; updated: number; preview: CsvPreview }>;
```

1. Call `previewArticleCsv`; if `errors.length > 0` throw
   `CsvImportValidationError` carrying the preview. No DB work.
2. For each preview row, find the existing property-scope article by
   `topic_key` under RLS.
3. If found, call S03-01 `editArticle`; otherwise `createArticle`.
4. Return counts. The caller owns BEGIN/COMMIT; a thrown DB error rolls the
   whole file back.

The caller is the future staff route/CLI; S03-02 does not call `requireRole`
(the S04-01 route owns the guard and closes S02-06). The import is a trusted
service, not a public endpoint.

### 5.4 Errors

- `CsvParseError` - structural CSV failure (unclosed quote, bad header).
- `CsvImportValidationError` - one or more row errors; carries `CsvPreview`.
- S03-01 errors propagate unchanged (`ArticleTopicConflictError`,
  `ArticleValidationError`); the transaction rollback is the caller's.

## 6. Tenancy and security

- Preview has no tenant access.
- Commit runs inside `withTenant` / `withStaffSession`; every SELECT/INSERT is
  RLS-scoped.
- A CSV cannot address another property: there is no `property_id` column and
  `source_id` is not accepted.
- Body text is hotel content; it is never put in audit detail or logs.
- Row limit 500 prevents a single request from unbounded work.

## 7. Test plan

Unit - `tests/knowledge/csv.test.ts`:
- 100-row valid file -> 100 rows, 0 errors.
- missing header, unknown header, duplicate header, wrong column count.
- quoted comma, escaped quote, embedded newline, CRLF, BOM.
- unclosed quote -> `CsvParseError`.
- empty body, bad language, bad topic, empty title, duplicate topic in file.
- multiple errors on one row are all reported.
- preview never touches the DB (no client argument).

DB - `tests/db/import.db.test.ts`:
- 100-row import creates 100 articles + 100 retired versions; counts match.
- second import of the same file creates 100 new versions, not 100 articles.
- one invalid row -> no articles/versions/audit rows written.
- existing topic updates via S03-01 (title/body) and keeps history.
- property-B context cannot see/update property-A topics.
- a forced DB failure mid-file rolls back all earlier rows (transaction
  ownership proof).

## 8. Evidence

```text
$ npm test                 # CSV parser/preview units
$ npm run db:test          # import suite + existing suites
$ npm run typecheck && npm run lint && npm run build
```

Runbook S03-02 records the 100-row counts, the no-partial-import proof and the
malformed-CSV cases.

## 9. Risks and open questions

- **No dependency.** A small RFC 4180 parser is in scope; if it grows beyond
  quoting/BOM/CRLF, adding `csv-parse` needs explicit approval.
- **All-or-nothing** is chosen over partial import. A 500-row file with one
  bad row fails; the preview tells the content owner exactly what to fix.
- **No UI/route.** API/service-first; S08 owns upload. S02-06 stays open until
  S04-01.
- **CSV is not the content model.** It imports plain text only; rich text,
  images and PDFs are out.

## 10. Definition of done

- [ ] Preview is pure, reports every row error, and is covered by unit tests.
- [ ] 100-row import and all-or-nothing rollback proven in the DB suite.
- [ ] Reuses S03-01 create/edit and its audit rows; no duplicate articles.
- [ ] No new dependency; no schema change; no HTTP route.
- [ ] Runbook entry with evidence; workbook tick after merge.
- [ ] Review threads resolved.
