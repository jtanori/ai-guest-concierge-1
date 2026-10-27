/**
 * W00-13 — read a `.env` file, without a dependency.
 *
 * `node --env-file` exists and is what `npm start` uses, but it has two limits that
 * matter for a readiness check: it throws on a missing file (a check should say
 * *which* file is missing, in its own words) and it cannot be pointed at a file by
 * a test. Thirty lines of parser also mean the behaviour is visible: a typo is an
 * error here rather than a silently ignored line.
 *
 * Deliberately NOT supported: `${VAR}` interpolation and multiline values. Neither
 * is used by anything in this repo, and both are where hand-rolled parsers start
 * disagreeing with every other implementation.
 */
import { readFileSync } from "node:fs";

export class DotenvError extends Error {}

export interface ParsedEnvFile {
  values: Record<string, string>;
  /** 1-based line numbers, for a message that can be acted on. */
  lines: number;
}

/** A line that is blank, or a comment starting at column 0. */
function isIgnorable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * `KEY=value` → `{ key, value }`, honouring surrounding quotes.
 *
 * An unquoted value stops at the first ` #`, so `EMAIL_FROM=Concierge <a@b.com> # desk`
 * keeps the address and drops the note. A quoted value keeps everything inside the
 * quotes, which is the only way to embed a `#` (a password, typically).
 */
export function parseEnvLine(line: string): { key: string; value: string } | null {
  const withoutExport = line.trimStart().startsWith("export ")
    ? line.trimStart().slice("export ".length)
    : line;
  const equals = withoutExport.indexOf("=");
  if (equals <= 0) return null;

  const key = withoutExport.slice(0, equals).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let raw = withoutExport.slice(equals + 1).trim();
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    raw = end === -1 ? raw.slice(1) : raw.slice(1, end);
  } else if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    raw = end === -1 ? raw.slice(1) : raw.slice(1, end);
  } else {
    const comment = raw.indexOf(" #");
    if (comment !== -1) raw = raw.slice(0, comment).trimEnd();
  }
  return { key, value: raw };
}

/**
 * Parse a whole file. Throws `DotenvError` naming the line for anything that is
 * neither blank, a comment, nor `KEY=value` — a `.env` file that silently ignores a
 * line is a variable somebody believes is set.
 */
export function parseEnvFile(contents: string): ParsedEnvFile {
  const values: Record<string, string> = {};
  const lines = contents.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (isIgnorable(line)) return;
    const parsed = parseEnvLine(line);
    if (parsed === null) {
      throw new DotenvError(
        `line ${index + 1} is not a KEY=value assignment: ${line.trim().slice(0, 60)}`,
      );
    }
    values[parsed.key] = parsed.value;
  });
  return { values, lines: lines.length };
}

export function loadEnvFile(path: string): ParsedEnvFile {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new DotenvError(`cannot read env file: ${path}`);
  }
  return parseEnvFile(contents);
}
