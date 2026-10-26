/**
 * The guard for a class of bug CI could not see.
 *
 * The server runs under Node's `--experimental-strip-types`, which *erases* types
 * rather than compiling them. It therefore rejects "erasable syntax" it cannot
 * strip — TypeScript parameter properties (`constructor(readonly x: string)`),
 * `enum`, `namespace`, and constructor overloads. `tsc` and vitest both accept
 * them, so a file can be green in `typecheck`, green in `test`, green in
 * `db-test`, and still throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on boot.
 *
 * That is exactly what happened in S08-03: `RequestNotActionableError` used a
 * parameter property, every check passed, and the API refused to start. It was
 * found by hand, in a live check, after the PR merged.
 *
 * So this test does the thing CI never did: it *imports every module the server
 * can load*, with the same flags the server uses, in one process. Importing is
 * enough — the failure is a parse error, not a runtime one.
 *
 * `src/server.ts` is excluded on purpose: importing it binds a port and starts
 * the request loop. Everything it imports is covered by walking the tree, which
 * is the part that can break.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const ENTRY = join(ROOT, "src/server.ts");

function modules(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      modules(path, found);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && path !== ENTRY) {
      found.push(path);
    }
  }
  return found;
}

describe("runtime: the server can actually boot (strip-types)", () => {
  it("every src module parses under --experimental-strip-types", () => {
    const files = modules(join(ROOT, "src")).sort();
    expect(files.length).toBeGreaterThan(30);

    const script = `
      const files = ${JSON.stringify(files)};
      const failures = [];
      for (const file of files) {
        try {
          await import("file://" + file);
        } catch (error) {
          if (error && error.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
            failures.push(file + ": " + String(error.message).split("\\n")[0]);
          }
          // Any other error is a module that needs the environment (a missing
          // env var, a database handle at import time). Those are not this test's
          // subject: the parse already succeeded, which is what it checks.
        }
      }
      if (failures.length > 0) {
        console.error(failures.join("\\n"));
        process.exit(1);
      }
    `;

    expect(() =>
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
        { cwd: ROOT, encoding: "utf8", stdio: "pipe", timeout: 120_000 },
      ),
    ).not.toThrow();
  });
});
