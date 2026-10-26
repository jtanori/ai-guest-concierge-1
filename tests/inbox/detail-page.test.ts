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

  it("posts the S08-03 actions as server-action forms, not client fetches", () => {
    // A form works before hydration and keeps the bearer token in the HttpOnly
    // cookie; a client fetch here would need the token in the browser.
    for (const action of ["replyAction", "takeOverAction", "resolveAction", "assignToMeAction"]) {
      expect(source).toContain(`action={${action}}`);
    }
    // The mutations live in a `"use server"` module: nothing in the page itself
    // posts with a token, so the browser never holds one.
    const actions = readFileSync(
      new URL("../../web/app/(staff)/inbox/[conversationId]/actions.ts", import.meta.url),
      "utf8",
    );
    expect(actions.startsWith('"use server";')).toBe(true);
  });

  it("offers only the lifecycle edges the database will accept (S09-01)", () => {
    // 0024 answers 409 to an edge that is not in the matrix, so a button that is
    // always on screen is a button that reliably fails — and staff who learn one
    // button lies stop trusting the rest of the bar. Each request-scoped action
    // is therefore gated on the status it is legal *from*.
    expect(source).toContain("action={acknowledgeAction}");
    expect(source).toContain('openRequest.status !== "new" ? null');
    expect(source).toContain("action={cancelRequestAction}");
    expect(source).toContain('openRequest.status !== "assigned" ? null');
  });

  it("renders the request status through the catalogue, not raw (S09-01)", () => {
    // The list screen already translated these five words; the detail screen did
    // not, so the same request read differently on the two screens. A raw
    // `{request.status}` also has no ceiling — a sixth status would surface in
    // English on the Spanish screen with nothing failing.
    expect(source).toContain("REQUEST_LABEL[request.status]");
    expect(code).not.toContain("{request.status}");
  });

  it("hooks the S09-03 flag onto the answer itself (S09-03)", () => {
    // The attribute S08-02 pre-installed is now load-bearing: the button posts it,
    // and the AC is attribution to the run rather than to the bubble.
    expect(source).toContain("data-ai-run-id");
    expect(source).toContain('name="aiRunId" value={message.aiRun.aiRunId}');
    expect(source).toContain("action={flagAnswerAction}");
    // The note is optional and rides in the SAME form: 0026 grants no UPDATE on
    // answer_flags, so a note cannot be attached to a flag afterwards.
    const start = source.indexOf("action={flagAnswerAction}");
    // Comments stripped from the slice too: the prose in this form explains why
    // the note is NOT required, so the word appears in a comment.
    const flagForm = source
      .slice(start, source.indexOf("</form>", start))
      .replace(/\{\/[\s\S]*?\/\}/g, "");
    expect(flagForm).toContain('name="note"');
    // Scoped to this form on purpose: the reply textarea above it IS required, and
    // an empty reply is meaningless. An empty note is not — it is the common case.
    expect(flagForm).not.toMatch(/\brequired\b/);
  });

  it("shows the flag on the answer, and the notes as text (S09-03)", () => {
    // The indicator belongs on the bubble. A separate roster of complaints invites
    // reading the answer without them, which is how a wrong answer keeps being
    // trusted by the next person who opens the thread.
    expect(source).toContain("message.aiRun.flags");
    expect(source).toContain("staff.flag.flagged");
    expect(source).toContain("{flag.note}");
  });

  it("stops offering the button to the person who already pressed it (S09-03)", () => {
    // The schema refuses a second flag from the same person, so showing the button
    // again would be showing something that cannot work.
    expect(source).toContain("flag.mine");
    expect(source).toContain('flags.some((flag) => flag.mine) ? null');
  });

  it("labels a citation whose version is no longer current, rather than hiding it", () => {
    // AC-2's twin: an answer that cites history is history working, and staff
    // need to see that the source moved on without the answer being wrong.
    expect(source).toContain('tr("staff.inbox.not_current")');
    expect(source).toContain("citation.isCurrent");
  });
});
