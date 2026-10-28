import { describe, expect, it } from "vitest";
import { DotenvError, parseEnvFile, parseEnvLine } from "./dotenv.ts";

/**
 * The parser exists so `check:readiness --file .env.staging` reads the same thing
 * the deploy does. Its failure modes are dull, which is the point: a `.env` line
 * that is silently ignored is a variable somebody believes is set.
 */
describe("parseEnvLine", () => {
  it("reads the obvious form", () => {
    expect(parseEnvLine("APP_ENV=staging")).toEqual({ key: "APP_ENV", value: "staging" });
  });

  it("accepts `export`, surrounding whitespace, and an empty value", () => {
    expect(parseEnvLine("export LOG_LEVEL=info")).toEqual({ key: "LOG_LEVEL", value: "info" });
    expect(parseEnvLine("  LLM_API_KEY=abc  ")).toEqual({ key: "LLM_API_KEY", value: "abc" });
    expect(parseEnvLine("SENTRY_DSN=")).toEqual({ key: "SENTRY_DSN", value: "" });
  });

  it("keeps a `#` inside quotes and drops a trailing comment outside them", () => {
    expect(parseEnvLine('DB_PASSWORD="pa#ss word"')).toEqual({
      key: "DB_PASSWORD",
      value: "pa#ss word",
    });
    expect(parseEnvLine("LOG_LEVEL=debug # chatty")).toEqual({ key: "LOG_LEVEL", value: "debug" });
  });

  it("keeps an address that contains angle brackets and spaces", () => {
    expect(parseEnvLine("EMAIL_FROM=Concierge <desk@example.com>")).toEqual({
      key: "EMAIL_FROM",
      value: "Concierge <desk@example.com>",
    });
  });

  it("returns null for anything that is not an assignment", () => {
    expect(parseEnvLine("this is not a variable")).toBeNull();
    expect(parseEnvLine("=novalue")).toBeNull();
    expect(parseEnvLine("1BAD=nope")).toBeNull();
  });
});

describe("parseEnvFile", () => {
  it("ignores blank lines and comments and keeps order-independent values", () => {
    const parsed = parseEnvFile(
      ["# a comment", "", "APP_ENV=prod", "   ", "DATABASE_URL=postgres://u:p@h/d"].join("\n"),
    );
    expect(parsed.values).toEqual({
      APP_ENV: "prod",
      DATABASE_URL: "postgres://u:p@h/d",
    });
  });

  it("handles CRLF files (every Windows checkout)", () => {
    expect(parseEnvFile("APP_ENV=staging\r\nLOG_LEVEL=info\r\n").values).toEqual({
      APP_ENV: "staging",
      LOG_LEVEL: "info",
    });
  });

  it("refuses a malformed line instead of skipping it, and says which line", () => {
    expect(() => parseEnvFile("APP_ENV=local\nthis line is wrong\n")).toThrow(DotenvError);
    expect(() => parseEnvFile("APP_ENV=local\nthis line is wrong\n")).toThrow(/line 2/);
  });

  it("keeps the last assignment when a file sets a key twice", () => {
    // Matching `node --env-file`: the later definition wins, so a developer
    // overriding a shared block at the bottom of the file gets what they expect.
    expect(parseEnvFile("A=1\nA=2\n").values).toEqual({ A: "2" });
  });
});
