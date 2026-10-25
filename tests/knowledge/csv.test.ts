import { describe, expect, it } from "vitest";
import {
  CSV_MAX_BYTES,
  CSV_MAX_ROWS,
  CsvParseError,
  previewArticleCsv,
} from "../../src/knowledge/csv.ts";

const HEADER = "topic_key,title,language,body";

function rowsCsv(rows: string[]): string {
  return `${HEADER}\n${rows.join("\n")}`;
}

describe("CSV preview (S03-02)", () => {
  it("previews a valid 100-row file without touching a database", () => {
    const rows = Array.from(
      { length: 100 },
      (_, index) => `bulk.topic${index},Bulk ${index},en,Bulk body ${index}.`,
    );
    const preview = previewArticleCsv(rowsCsv(rows));

    expect(preview.counts).toEqual({ total: 100, valid: 100, invalid: 0 });
    expect(preview.errors).toEqual([]);
    expect(preview.rows).toHaveLength(100);
    expect(preview.rows[0]).toEqual({
      row: 1,
      draft: {
        topicKey: "bulk.topic0",
        title: "Bulk 0",
        language: "en",
        body: "Bulk body 0.",
      },
    });
    expect(preview.rows[99]!.row).toBe(100);
  });

  it("accepts a BOM, CRLF, case-insensitive headers and surrounding spaces", () => {
    const csv = `\uFEFF Topic_Key , Title , Language , Body \r\npool.hours,Pool hours,EN,Open daily.\r\n`;
    const preview = previewArticleCsv(csv);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]!.draft).toEqual({
      topicKey: "pool.hours",
      title: "Pool hours",
      language: "en",
      body: "Open daily.",
    });
  });

  it("parses quoted commas, escaped quotes and embedded newlines", () => {
    const csv = rowsCsv([
      'pool.hours,"Pool, hours",en,"He said ""hello"", then left.\nSecond line."',
    ]);
    const preview = previewArticleCsv(csv);
    expect(preview.errors).toEqual([]);
    expect(preview.rows[0]!.draft).toMatchObject({
      topicKey: "pool.hours",
      title: "Pool, hours",
      language: "en",
      body: 'He said "hello", then left.\nSecond line.',
    });
  });

  it("reports every field error on a row, not just the first", () => {
    const preview = previewArticleCsv(rowsCsv(["Pool Hours,Bad title,fr,"]));
    expect(preview.counts).toEqual({ total: 1, valid: 0, invalid: 1 });
    expect(preview.rows).toEqual([]);
    expect(preview.errors.map((error) => error.field)).toEqual([
      "topic_key",
      "language",
      "body",
    ]);
    expect(preview.errors.every((error) => error.row === 1)).toBe(true);
  });

  it("rejects a later duplicate topic_key without dropping the first row", () => {
    const preview = previewArticleCsv(
      rowsCsv([
        "pool.hours,Pool hours,en,Open daily.",
        "pool.hours,Pool hours again,en,Open daily.",
      ]),
    );
    expect(preview.counts).toEqual({ total: 2, valid: 1, invalid: 1 });
    expect(preview.rows.map((row) => row.row)).toEqual([1]);
    expect(preview.errors).toEqual([
      {
        row: 2,
        field: "topic_key",
        message: 'duplicate topic_key "pool.hours" in this file',
      },
    ]);
  });

  it("does not let invalid topics pollute duplicate detection", () => {
    const preview = previewArticleCsv(
      rowsCsv([
        "pool.hours,Pool,en,Open daily.",
        "POOL.HOURS,Pool,en,Open daily.",
        "POOL.HOURS,Pool,en,Open daily.",
      ]),
    );
    expect(preview.counts).toEqual({ total: 3, valid: 1, invalid: 2 });
    expect(preview.errors).toHaveLength(2);
    expect(preview.errors.every((error) => error.field === "topic_key")).toBe(true);
    expect(preview.errors.some((error) => /duplicate/.test(error.message))).toBe(false);
  });

  it("reports wrong column counts as row errors and keeps row numbers stable", () => {
    const preview = previewArticleCsv(
      rowsCsv([
        "pool.hours,Pool hours,en",
        "spa.services,Spa,en,Open daily.",
      ]),
    );
    expect(preview.counts).toEqual({ total: 2, valid: 1, invalid: 1 });
    expect(preview.rows[0]!.row).toBe(2);
    expect(preview.errors).toEqual([
      { row: 1, field: "columns", message: "expected 4 columns, got 3" },
    ]);
  });

  it("skips blank and whitespace-only lines but keeps data-row numbering", () => {
    const csv = `${HEADER}\n\n   \npool.hours,Pool,en,Open daily.\n\t\r\nspa.services,Spa,en,Open daily.\n   `;
    const preview = previewArticleCsv(csv);
    expect(preview.counts).toEqual({ total: 2, valid: 2, invalid: 0 });
    expect(preview.rows.map((row) => row.row)).toEqual([1, 2]);
  });

  it("keeps empty comma-separated fields as a genuine invalid row", () => {
    const preview = previewArticleCsv(rowsCsv([",,,"]));
    expect(preview.counts).toEqual({ total: 1, valid: 0, invalid: 1 });
    expect(preview.errors.map((error) => error.field)).toEqual([
      "topic_key",
      "title",
      "language",
      "body",
    ]);
  });

  it("rejects a header-only file as having no data rows", () => {
    expect(() => previewArticleCsv(HEADER)).toThrow(/no data rows/);
    expect(() => previewArticleCsv(`${HEADER}\n   \n`)).toThrow(/no data rows/);
  });

  it("rejects an empty file and malformed headers", () => {
    expect(() => previewArticleCsv("")).toThrow(CsvParseError);
    expect(() => previewArticleCsv("\uFEFF \r\n")).toThrow(CsvParseError);

    const cases: Array<[string, RegExp]> = [
      ["topic_key,title,language", /header must have exactly 4 columns/],
      ["topic_key,topic_key,language,body", /duplicate column/],
      ["topic_key,title,language,extra", /header must be exactly/],
      ["title,topic_key,language,body", /header order must be/],
    ];
    for (const [csv, message] of cases) {
      expect(() => previewArticleCsv(csv), csv).toThrow(message);
    }
  });

  it("throws a typed parse error for an unclosed quote", () => {
    try {
      previewArticleCsv(rowsCsv(['pool.hours,"Pool,en,Open daily.']));
      throw new Error("expected a parse error");
    } catch (error) {
      expect(error).toBeInstanceOf(CsvParseError);
      expect((error as CsvParseError).field).toBe("csv");
      expect((error as CsvParseError).message).toMatch(/unclosed quoted field/);
    }
  });

  it("rejects a bare CR outside quotes instead of splitting a row", () => {
    expect(() =>
      previewArticleCsv(
        `${HEADER}\npool.hours,Pool,en,Line1\rspa.hours,Spa,en,Line2\n`,
      ),
    ).toThrow(/bare CR outside a quoted field/);
    expect(() =>
      previewArticleCsv(`${HEADER}\npool.hours,"Pool",en,"Body"\r`),
    ).toThrow(/bare CR outside a quoted field/);
  });

  it("rejects stray quotes in unquoted fields", () => {
    expect(() => previewArticleCsv(rowsCsv(['pool.hours,Po"ol,en,Body.']))).toThrow(
      /unexpected quote in unquoted field/,
    );
    expect(() => previewArticleCsv(rowsCsv(['pool.hours, "Pool",en,Body.']))).toThrow(
      /unexpected quote in unquoted field/,
    );
  });

  it("rejects more than the 500-row limit before row validation", () => {
    const rows = Array.from(
      { length: CSV_MAX_ROWS + 1 },
      (_, index) => `bulk.topic${index},Bulk ${index},en,Body ${index}.`,
    );
    expect(() => previewArticleCsv(rowsCsv(rows))).toThrow(
      new RegExp(`more than ${CSV_MAX_ROWS} data rows`),
    );
  });

  it("rejects an input larger than the byte ceiling", () => {
    expect(() => previewArticleCsv("a".repeat(CSV_MAX_BYTES + 1))).toThrow(
      /larger than/,
    );
  });

  it("rejects empty bodies and unsupported languages", () => {
    const preview = previewArticleCsv(rowsCsv(['pool.hours,Pool,fr,""']));
    expect(preview.errors.map((error) => error.field)).toEqual([
      "language",
      "body",
    ]);
  });

  it("is deterministic and side-effect free across calls", () => {
    const csv = rowsCsv(["pool.hours,Pool,en,Open daily."]);
    expect(previewArticleCsv(csv)).toEqual(previewArticleCsv(csv));
  });
});
