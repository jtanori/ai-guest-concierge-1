/**
 * W00-15 — golden-question set v1: format rules and validator.
 *
 * Format (plan Appendix A):
 *   property_id,language,question,expected_behaviour,target_topic,notes
 *
 * `expected_behaviour` is behaviour, NEVER an expected string — matching
 * behaviour measures the product; matching strings measures phrasing.
 *
 * v1 deliberately ships 20 rows: 13 answer-expected / 7 escalation-expected.
 * Escalation cases are hand-authored (they are exactly the questions the
 * articles do NOT answer); answer cases exist to be covered systematically.
 */
import { readFileSync } from "node:fs";

export const EXPECTED_BEHAVIOURS = ["answer", "escalate", "refuse"] as const;
export type ExpectedBehaviour = (typeof EXPECTED_BEHAVIOURS)[number];

export const QUESTION_COLUMNS = [
  "property_id",
  "language",
  "question",
  "expected_behaviour",
  "target_topic",
  "notes",
] as const;

export interface GoldenQuestion {
  propertyId: string;
  language: string;
  question: string;
  expected: ExpectedBehaviour;
  targetTopic: string | null;
  notes: string;
}

/** Minimal RFC-4180 CSV: quoted fields, escaped quotes, LF or CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch === "\r") {
      // skip — LF terminates the row
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export class GoldenSetError extends Error {}

export function validateGoldenQuestions(
  text: string,
  opts: { minRows: number; propertyLanguages: readonly string[] },
): GoldenQuestion[] {
  const parsed = parseCsv(text);
  if (parsed.length === 0) throw new GoldenSetError("golden set is empty");

  const header = parsed[0] as string[];
  const headerExpected = [...QUESTION_COLUMNS];
  if (
    header.length !== headerExpected.length ||
    header.some((h, i) => h !== headerExpected[i])
  ) {
    throw new GoldenSetError(
      `header must be exactly: ${headerExpected.join(",")}`,
    );
  }

  const questions: GoldenQuestion[] = [];
  for (const [index, r] of parsed.slice(1).entries()) {
    const line = index + 2; // 1-based, after header
    if (r.length < headerExpected.length) {
      throw new GoldenSetError(`row ${line}: has ${r.length} fields, expected 6`);
    }
    const [propertyId, language, question, expected, targetTopic, notes] = r as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    if (!propertyId) throw new GoldenSetError(`row ${line}: empty property_id`);
    if (!opts.propertyLanguages.includes(language)) {
      throw new GoldenSetError(
        `row ${line}: language "${language}" not in property languages ` +
          `[${opts.propertyLanguages.join(", ")}]`,
      );
    }
    if (!question) throw new GoldenSetError(`row ${line}: empty question`);
    if (!(EXPECTED_BEHAVIOURS as readonly string[]).includes(expected)) {
      throw new GoldenSetError(
        `row ${line}: expected_behaviour must be one of ` +
          `${EXPECTED_BEHAVIOURS.join("|")}, got "${expected}"`,
      );
    }
    if (expected === "answer" && !targetTopic) {
      throw new GoldenSetError(
        `row ${line}: answer-expected questions must name target_topic`,
      );
    }
    if (expected === "escalate" && targetTopic) {
      throw new GoldenSetError(
        `row ${line}: escalation cases do not name a topic (they are the ` +
          "questions the articles do not answer)",
      );
    }
    if (expected !== "answer" && !notes) {
      throw new GoldenSetError(
        `row ${line}: escalate/refuse rows need a hand-written note saying why`,
      );
    }

    questions.push({
      propertyId,
      language,
      question,
      expected: expected as ExpectedBehaviour,
      targetTopic: targetTopic || null,
      notes,
    });
  }

  if (questions.length < opts.minRows) {
    throw new GoldenSetError(
      `golden set has ${questions.length} questions, minimum is ${opts.minRows}`,
    );
  }

  const escalations = questions.filter((q) => q.expected !== "answer").length;
  const escalationShare = escalations / questions.length;
  if (escalationShare < 0.25) {
    throw new GoldenSetError(
      `escalation share ${(escalationShare * 100).toFixed(0)}% is below the ` +
        "25% floor — a set biased toward what KB articles answer is useless " +
        "for the false-answer gate",
    );
  }

  return questions;
}

export function loadGoldenQuestions(
  path: string,
  opts: { minRows: number; propertyLanguages: readonly string[] },
): GoldenQuestion[] {
  return validateGoldenQuestions(readFileSync(path, "utf8"), opts);
}
