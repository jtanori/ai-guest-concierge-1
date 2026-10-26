/**
 * S08-02 — the guardrail on the screen whose whole content is guest text.
 *
 * The API returns raw message bodies (deliberately: escaping in the service
 * would corrupt the transcript for every other consumer, and double-escape on
 * the next hop). That makes the *renderer* the only thing standing between a
 * guest typing `<script>` and a staff browser running it.
 *
 * React escapes JSX text children by default — but "by default" is one edit away
 * from `dangerouslySetInnerHTML`, and that edit is exactly what a later "make
 * the quote highlight work" change looks like. So the rule is asserted here, on
 * the source, rather than trusted: a test that fails when the one dangerous API
 * appears in the file is cheap, and the alternative is discovering it from a
 * support ticket.
 *
 * This is a source check, not a render test: the page is a Next server component
 * and rendering it would need the whole request pipeline. What is checked is
 * what a code review would check.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PAGE = new URL("../../web/app/(staff)/inbox/[conversationId]/page.tsx", import.meta.url);
const source = readFileSync(PAGE, "utf8");

/**
 * The prose in this page explains *why* the dangerous API is not used, so the
 * literal appears in comments. Strip them: the assertion is about code.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

describe("conversation detail page", () => {
  it("never injects HTML, so guest text stays text", () => {
    expect(code).not.toContain("dangerouslySetInnerHTML");
    expect(code).not.toContain("innerHTML");
  });

  it("renders citations as plain children, not as markup", () => {
    // The quote and the cited body are the two strings a guest indirectly
    // influences (via the article, which staff and importers write), so they get
    // their own assertion: `{citation.quote}` / `{citation.body}` as JSX
    // children, never `set:html` or a template literal handed to a sink.
    expect(source).toContain("{citation.quote}");
    expect(source).toContain("{citation.body}");
    expect(source).toContain("{message.body}");
  });

  it("tags AI messages with data-ai-run-id for the S09-03 flag affordance", () => {
    expect(source).toContain("data-ai-run-id");
  });

  it("labels a citation whose version is no longer current, rather than hiding it", () => {
    // AC-2's twin: an answer that cites history is history working, and staff
    // need to see that the source moved on without the answer being wrong.
    expect(source).toContain('tr("staff.inbox.not_current")');
    expect(source).toContain("citation.isCurrent");
  });
});
