/**
 * S03-02 - dependency-free CSV preview for bulk article import.
 *
 * The parser is deliberately small and pure: no DB, no I/O, no package. It
 * reports every row-level error it can instead of stopping at the first, so
 * the content owner sees the whole file's problems before anything is written.
 * Structural failures (empty file, bad header, unclosed quote, >500 rows)
 * throw `CsvParseError`; row failures are returned in `CsvPreview.errors`.
 */
import {
  ArticleValidationError,
  validateBody,
  validateLanguage,
  validateTitle,
  validateTopicKey,
  type ArticleDraft,
  type ArticleLanguage,
} from "./articles.ts";

export const CSV_COLUMNS = ["topic_key", "title", "language", "body"] as const;
export const CSV_MAX_ROWS = 500;

export interface CsvRowError {
  row: number;
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

export class CsvParseError extends Error {
  readonly row: number | null;
  readonly field: string | null;

  constructor(message: string, options: { row?: number; field?: string } = {}) {
    super(message);
    this.name = "CsvParseError";
    this.row = options.row ?? null;
    this.field = options.field ?? null;
  }
}

export class CsvImportValidationError extends Error {
  readonly preview: CsvPreview;

  constructor(preview: CsvPreview) {
    super(
      `CSV has ${preview.errors.length} validation error(s) in ${preview.counts.invalid} row(s); nothing was imported`,
    );
    this.name = "CsvImportValidationError";
    this.preview = preview;
  }
}

interface RawRecord {
  fields: string[];
  /** 1-based physical line where the record starts (header diagnostics). */
  line: number;
}

function parseRecords(input: string): RawRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: RawRecord[] = [];

  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let line = 1;
  let recordLine = 1;
  let hasContent = false;

  const pushField = (): void => {
    fields.push(field);
    field = "";
    afterQuote = false;
  };

  const pushRecord = (): void => {
    pushField();
    records.push({ fields, line: recordLine });
    fields = [];
    recordLine = line + 1;
    hasContent = false;
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        afterQuote = true;
        index += 1;
        continue;
      }
      if (char === "\r") {
        field += "\n";
        line += 1;
        index += text[index + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (char === "\n") {
        field += "\n";
        line += 1;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (afterQuote) {
      if (char === ",") {
        pushField();
        index += 1;
        continue;
      }
      if (char === "\r" || char === "\n") {
        pushRecord();
        index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
        line += 1;
        continue;
      }
      throw new CsvParseError(
        `unexpected character after a closing quote on line ${line}`,
        { row: line, field: "csv" },
      );
    }

    if (char === '"') {
      if (field.length === 0) {
        inQuotes = true;
        hasContent = true;
        index += 1;
        continue;
      }
      // Lenient for real-world text: a quote inside an unquoted field is
      // literal, not a structural failure.
      field += char;
      hasContent = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      pushField();
      hasContent = true;
      index += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (hasContent || field.length > 0 || fields.length > 0) {
        pushRecord();
      } else {
        fields = [];
        field = "";
        recordLine = line + 1;
      }
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      line += 1;
      continue;
    }

    field += char;
    hasContent = true;
    index += 1;
  }

  if (inQuotes) {
    throw new CsvParseError("unclosed quoted field", { row: line, field: "csv" });
  }
  if (hasContent || field.length > 0 || fields.length > 0) pushRecord();
  return records;
}

function assertHeader(records: RawRecord[]): void {
  const headerRecord = records[0];
  if (headerRecord === undefined) {
    throw new CsvParseError("CSV is empty", { row: 1, field: "header" });
  }

  const header = headerRecord.fields.map((name) => name.trim().toLowerCase());
  const expected = CSV_COLUMNS as readonly string[];

  if (header.length !== expected.length) {
    throw new CsvParseError(
      `header must have exactly ${expected.length} columns (${expected.join(",")}), got ${header.length}`,
      { row: headerRecord.line, field: "header" },
    );
  }
  if (new Set(header).size !== header.length) {
    throw new CsvParseError("header contains a duplicate column", {
      row: headerRecord.line,
      field: "header",
    });
  }
  if (header.some((name) => !expected.includes(name)) || expected.some((name) => !header.includes(name))) {
    throw new CsvParseError(
      `header must be exactly ${expected.join(",")}; got ${header.join(",")}`,
      { row: headerRecord.line, field: "header" },
    );
  }
  if (header.some((name, index) => name !== expected[index])) {
    throw new CsvParseError(
      `header order must be ${expected.join(",")}; got ${header.join(",")}`,
      { row: headerRecord.line, field: "header" },
    );
  }
}

function messageOf(error: unknown): string {
  if (error instanceof ArticleValidationError) {
    const prefix = `${error.field}: `;
    return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function rowError(row: number, field: string, error: unknown): CsvRowError {
  return { row, field, message: messageOf(error) };
}

/**
 * Parses and validates a CSV without touching the database. The returned
 * `rows` contains only drafts that passed every field check; `errors` is empty
 * iff the whole file is valid.
 */
export function previewArticleCsv(input: string): CsvPreview {
  if (typeof input !== "string") {
    throw new CsvParseError("CSV input must be a string", { row: 1, field: "csv" });
  }
  if (input.replace(/^\uFEFF/, "").trim().length === 0) {
    throw new CsvParseError("CSV is empty", { row: 1, field: "header" });
  }

  const records = parseRecords(input);
  assertHeader(records);

  const data = records.slice(1);
  if (data.length > CSV_MAX_ROWS) {
    throw new CsvParseError(
      `CSV has ${data.length} data rows; maximum is ${CSV_MAX_ROWS}`,
      { row: 1, field: "rows" },
    );
  }

  const rows: CsvPreviewRow[] = [];
  const errors: CsvRowError[] = [];
  const seenTopics = new Set<string>();
  let invalidRows = 0;

  data.forEach((record, index) => {
    const row = index + 1;
    if (record.fields.length !== CSV_COLUMNS.length) {
      errors.push({
        row,
        field: "columns",
        message: `expected ${CSV_COLUMNS.length} columns, got ${record.fields.length}`,
      });
      invalidRows += 1;
      return;
    }

    const [rawTopic = "", rawTitle = "", rawLanguage = "", rawBody = ""] = record.fields;
    const rowErrors: CsvRowError[] = [];

    let topicKey = rawTopic.trim();
    let title: string | undefined;
    let language: ArticleLanguage | undefined;
    let body: string | null | undefined;

    try {
      topicKey = validateTopicKey(rawTopic);
    } catch (error) {
      rowErrors.push(rowError(row, "topic_key", error));
    }
    try {
      title = validateTitle(rawTitle);
    } catch (error) {
      rowErrors.push(rowError(row, "title", error));
    }
    try {
      language = validateLanguage(rawLanguage);
    } catch (error) {
      rowErrors.push(rowError(row, "language", error));
    }
    try {
      body = validateBody(rawBody);
    } catch (error) {
      rowErrors.push(rowError(row, "body", error));
    }

    if (topicKey.length > 0) {
      if (seenTopics.has(topicKey)) {
        rowErrors.push({
          row,
          field: "topic_key",
          message: `duplicate topic_key "${topicKey}" in this file`,
        });
      } else {
        seenTopics.add(topicKey);
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      invalidRows += 1;
      return;
    }

    rows.push({
      row,
      draft: {
        topicKey,
        title: title!,
        body: body!,
        language: language!,
      },
    });
  });

  return {
    rows,
    errors,
    counts: { total: data.length, valid: rows.length, invalid: invalidRows },
  };
}
