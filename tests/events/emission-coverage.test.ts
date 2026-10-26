/**
 * S10-01 AC-1 — the emission coverage scan.
 *
 * AC-1 says the canonical events are emitted "from production paths, not just
 * tests", and the only way to make that executable is to read the production paths:
 * a DB test can prove the events it happened to drive, never the ones it did not.
 *
 * This lives in the pure suite rather than tests/db/ because it needs no database —
 * it parses source. That is deliberate: the guard should run on every `npm test`,
 * not only when a Postgres is available.
 *
 * WHY THE AST AND NOT A REGEX. The first version of this scan matched `emitEvent(`
 * in raw text, which cannot tell a call from a comment or a string that happens to
 * contain one. Issue #148 reproduced it: a commented-out emit, a block comment and a
 * string literal were all counted as producers, so AC-1 could read green with nothing
 * emitting — the exact failure the test exists to catch. It also failed the other way:
 * a natural `// TODO(DF-02): emitEvent(...)` planning note would have tripped the
 * deferral guard below while adding no producer.
 *
 * The TypeScript compiler is already a devDependency (CI runs `tsc`), so parsing costs
 * no new dependency, and it fixes a third limitation the regex had: an aliased import
 * (`import { emitEvent as emit }`) is now resolved through the import declaration, so
 * the local name is tracked rather than assumed.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EVENT_NAMES } from "../../src/events/taxonomy.ts";
import { REQUEST_STATUSES } from "../../src/requests/lifecycle.ts";

/**
 * The two names with no producer, deferred by owner decision on 2026-10-26 (DEC-1 in
 * the S10-01 charter). `booking_link_clicked` belongs to DF-02 (opportunity click
 * tracking) and `outbound_webhook_delivered` to DF-01 (outbound webhook per property);
 * both are deferred to MVP-1.5 and neither is started. They stay in EVENT_NAMES and in
 * 0001's CHECK constraint as reserved taxonomy — deleting them would churn the
 * taxonomy and lose the names DF-01/DF-02 will need.
 */
const DEFERRED = ["booking_link_clicked", "outbound_webhook_delivered"] as const;

/** Matches `../events/emit.ts` and `./emit.ts` without matching a same-named module
 * that happens to live somewhere else. */
const EMIT_MODULE = /(^|\/)events\/emit\.ts$|^\.\.?\/emit\.ts$/;

/**
 * The local names bound to `emitEvent` in one file, alias-aware. Empty when the file
 * does not import the writer at all — which is the common case, and the reason a call
 * to some *other* `emitEvent` in an unrelated module is not counted here.
 */
function importedEmitNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !EMIT_MODULE.test(specifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      // propertyName is the imported name, name the local one: `emitEvent as emit`
      // yields propertyName=emitEvent, name=emit. Without propertyName it is not
      // aliased and both are `emitEvent`.
      const imported = (element.propertyName ?? element.name).text;
      if (imported === "emitEvent") names.add(element.name.text);
    }
  }
  return names;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * The event names one source file can emit.
 *
 * Throws rather than skipping anything it does not understand: a silently ignored
 * computed name is a hole in AC-1 that no assertion would ever report.
 */
export function eventNamesInSource(fileName: string, text: string): Set<string> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const localNames = importedEmitNames(source);
  const found = new Set<string>();
  if (localNames.size === 0) return found;

  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression)) return;
    if (!localNames.has(node.expression.text)) return;

    const arg = node.arguments[2];
    const where = `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    if (arg === undefined) {
      throw new Error(`${where}: emitEvent call has no event-name argument`);
    }
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      found.add(arg.text);
      return;
    }
    if (ts.isTemplateExpression(arg)) {
      // Rebuild the template's shape so a computed name is matched on its structure
      // and not on a guess about its value.
      const shape =
        arg.head.text +
        arg.templateSpans
          .map((span) => `\${${span.expression.getText(source)}}${span.literal.text}`)
          .join("");
      if (shape === "request_${to}") {
        // src/requests/lifecycle.ts emits a computed name, guarded by
        // `if (to !== "cancelled")`, and rejects `new` as a target earlier. So the
        // reachable set is the statuses that are legal transition targets.
        for (const status of REQUEST_STATUSES) {
          if (status === "new" || status === "cancelled") continue;
          found.add(`request_${status}`);
        }
        return;
      }
      throw new Error(
        `${where}: unhandled template event name \`${shape}\` — teach this scan to expand it`,
      );
    }
    throw new Error(
      `${where}: event name is not a literal or a recognised template (${ts.SyntaxKind[arg.kind]})`,
    );
  });
  return found;
}

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every event name a production path in src/ can emit. */
export async function emittedNames(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const file of await sourceFiles(path.join(process.cwd(), "src"))) {
    // src/events/ is the taxonomy and the writer itself: emitting from there would
    // be the definition of "not a production path".
    if (file.includes(`${path.sep}events${path.sep}`)) continue;
    for (const name of eventNamesInSource(file, await readFile(file, "utf8"))) {
      found.add(name);
    }
  }
  return found;
}

/* ---------- the scan itself, against the fixtures from issue #148 ---------- */

describe("eventNamesInSource — what counts as a producer", () => {
  const probe = (body: string, importLine = 'import { emitEvent } from "../events/emit.ts";') =>
    `${importLine}
export async function probe(client: never, context: never, eventBase: never) {
${body}
}`;

  it("ignores comments and string literals, counting only the real call", async () => {
    // Issue #148's reproduction, verbatim in content: three of these four are not
    // calls, and the regex version of this scan reported all four.
    const text = probe(`  // await emitEvent(client, context, "booking_link_clicked", eventBase, {});
  /* emitEvent(client, context, "outbound_webhook_delivered", eventBase, {}) */
  const s = "emitEvent(client, context, \\"outbound_webhook_delivered\\", eventBase)";
  await emitEvent(client, context, "real_event", eventBase, {});
  return s;`);
    expect([...eventNamesInSource("probe.ts", text)]).toEqual(["real_event"]);
  });

  it("does not let a TODO note trip the deferral guard", async () => {
    // The annoying direction from #148: whoever starts DF-02 writes a planning note
    // and must not be told they added a producer.
    const text = probe(`  // TODO(DF-02): emitEvent(client, context, "booking_link_clicked", eventBase, {});
  await emitEvent(client, context, "request_created", eventBase, {});`);
    const names = eventNamesInSource("probe.ts", text);
    expect(names.has("booking_link_clicked")).toBe(false);
    expect([...names]).toEqual(["request_created"]);
  });

  it("follows an aliased import, which the regex version could not", async () => {
    const text = probe(
      `  await emit(client, context, "aliased_event", eventBase, {});`,
      'import { emitEvent as emit } from "../events/emit.ts";',
    );
    expect([...eventNamesInSource("probe.ts", text)]).toEqual(["aliased_event"]);
  });

  it("counts nothing in a file that does not import the writer", async () => {
    // A same-named function from somewhere else is not this writer. Without the
    // import check, any module with its own emitEvent would inflate the set.
    const text = `import { emitEvent } from "./somewhere-else.ts";
export async function probe(client: never, context: never, eventBase: never) {
  await emitEvent(client, context, "not_ours", eventBase, {});
}`;
    expect([...eventNamesInSource("probe.ts", text)]).toEqual([]);
  });

  it("expands the one computed name and throws on any other", async () => {
    const known = probe("  await emitEvent(client, context, `request_${to}`, eventBase, {});");
    expect([...eventNamesInSource("probe.ts", known)].sort()).toEqual([
      "request_acknowledged",
      "request_assigned",
      "request_resolved",
    ]);

    // Fail loud rather than skip: a silently ignored computed name is a hole in AC-1
    // that no assertion would ever report.
    const unknown = probe("  await emitEvent(client, context, `other_${kind}`, eventBase, {});");
    expect(() => eventNamesInSource("probe.ts", unknown)).toThrow(/unhandled template event name/);
  });
});

/* ---------- AC-1, over the real tree ---------- */

describe("S10-01 AC-1 — emission coverage across production paths", () => {
  it("emits 16 of the 18 canonical events from production paths", async () => {
    const emitted = await emittedNames();
    const expected = EVENT_NAMES.filter((n) => !(DEFERRED as readonly string[]).includes(n));
    expect(expected).toHaveLength(16);
    // Exact equality in both directions: a missing name is an uninstrumented path,
    // and an extra one is an event the taxonomy does not allow, which 0001's CHECK
    // constraint would refuse at runtime and turn into a failed request.
    expect([...emitted].sort()).toEqual([...expected].sort());
  });

  it("keeps the two deferred names declared but unemitted", async () => {
    // DEC-1 made executable. If someone wires a producer for either name this fails,
    // and the charter's AC-1 note becomes stale — which is the intended outcome: the
    // record should have to be updated on purpose.
    const emitted = await emittedNames();
    for (const name of DEFERRED) {
      expect(EVENT_NAMES, `${name} must stay reserved in the taxonomy`).toContain(name);
      expect(emitted.has(name), `${name} must have no production producer yet`).toBe(false);
    }
  });

  it("has no event name outside the canonical 18 anywhere in src/", async () => {
    // The CHECK constraint in 0001 would refuse an unknown name at runtime, so a
    // typo'd event name is a production error rather than a lost row. Catching it
    // here is much cheaper than catching it in an incident.
    const emitted = await emittedNames();
    const unknown = [...emitted].filter((n) => !EVENT_NAMES.includes(n as never));
    expect(unknown, `non-canonical event names emitted`).toEqual([]);
  });
});
