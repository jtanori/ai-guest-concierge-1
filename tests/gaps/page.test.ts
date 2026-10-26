/**
 * S09-02 — the gap queue screen, checked the way this repo checks screens that
 * render guest text.
 *
 * The queue's whole content is questions guests typed, so the renderer is the
 * only thing between a guest typing `<script>` and a staff browser running it —
 * the same argument `tests/inbox/detail-page.test.ts` makes for the transcript.
 * A source check rather than a render, because the page is a Next server
 * component and rendering it would need the whole request pipeline; what is
 * asserted is what a code review would assert.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { en, es } from "../../src/i18n/catalog.ts";

const PAGE = new URL("../../web/app/(staff)/gaps/page.tsx", import.meta.url);
const source = readFileSync(PAGE, "utf8");

/** The prose explains why the dangerous APIs are absent, so strip comments. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

describe("knowledge-gap screen (S09-02)", () => {
  it("never injects HTML, so a guest's question stays text", () => {
    expect(code).not.toContain("dangerouslySetInnerHTML");
    expect(code).not.toContain("innerHTML");
    expect(source).toContain("{gap.question}");
  });

  it("closes a gap through a server action, not a client fetch", () => {
    expect(source).toContain("action={closeGapAction}");
    const actions = readFileSync(
      new URL("../../web/app/(staff)/gaps/actions.ts", import.meta.url),
      "utf8",
    );
    expect(actions.startsWith('"use server";')).toBe(true);
    // The token is used only server-side: the page is a server component, so
    // `session.token` in its fetch header never reaches the browser, and the
    // HttpOnly cookie stays the only place the browser holds it. A "use client"
    // directive here would change that silently.
    expect(source).not.toContain('"use client"');
  });

  it("shows the median against its target, not as a bare number", () => {
    // Appendix D's ≤7 days is the reason the number exists. A median with no
    // target is a number nobody acts on, so both are rendered together and the
    // colour is decided by the comparison rather than left to the reader.
    expect(source).toContain('tr("staff.gaps.median")');
    expect(source).toContain('tr("staff.gaps.target")');
    expect(source).toContain("TARGET_DAYS");
    expect(code).toContain("median > TARGET_DAYS");
  });

  it("shows how many guests hit each miss", () => {
    // `hits` is the column that turns a list of questions into a priority order.
    expect(source).toContain("hitsLabel(gap.hits, tr)");
    expect(source).toContain("ageLabel(gap.openSeconds, tr)");
  });

  it("every label is a catalogue id that exists in both languages", () => {
    // No hardcoded staff copy: the screen is read in Spanish by the people who
    // work it, and an inline English string would survive review and ship.
    const literals = [...code.matchAll(/tr\("([a-z_.]+)"\)/g)].map((match) => match[1]!);
    expect(literals.length).toBeGreaterThan(8);
    for (const id of literals) {
      expect(id.startsWith("staff."), id).toBe(true);
      expect(en[id as keyof typeof en], `${id} (en)`).toBeDefined();
      expect(es[id as keyof typeof es], `${id} (es)`).toBeDefined();
    }
  });
});
