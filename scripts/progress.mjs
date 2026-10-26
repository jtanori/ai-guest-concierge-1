#!/usr/bin/env node
/**
 * Progress report — reads the backlog workbook and writes `docs/progress.md`.
 *
 * Usage: npm run progress        (or: node scripts/progress.mjs)
 *
 * WHY a generated file and not a hand-maintained one: the workbook is the source
 * of truth for item status (`scripts/update-workbook-status.mjs` writes it), and a
 * second hand-typed copy of "where are we" goes stale the moment an item closes.
 * This file cannot drift, because it is derived; the only thing it adds is a
 * snapshot of the previous run so the report can say what changed.
 *
 * WHAT it reads: `docs/07-master-backlog.xlsx`, sheet `03 · Master backlog`,
 * data from row 5. Column layout (verified by inspection, and by
 * scripts/update-workbook-status.mjs):
 *
 *   A=ID  B=Sprint  C=Track  D=Epic  E=Item  F=Description  G=Days  H=Pri
 *   I=Depends on  J=Acceptance criteria  K=Status
 *
 * Status glyphs: `✅` done, `🚧` in flight / partial, `☐` not started. The text
 * after the glyph is kept verbatim, because it usually names the blocker and
 * that is the most useful sentence in the report.
 *
 * Nine of the earliest items predate the glyph convention and simply say
 * `Done (...)`. Both spellings mean done, so both are read as done — but a
 * status in neither vocabulary is a hard error rather than a silent "todo",
 * because a miscount is the one failure this report cannot afford.
 *
 * WHAT it deliberately does not do: interpret the statuses. An item is done when
 * its cell starts with ✅, and the script says so out loud rather than trying to
 * guess from the wording.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import exceljsPkg from "exceljs";

const { Workbook } = exceljsPkg.default ?? exceljsPkg;

const ROOT = process.cwd();
const WORKBOOK = path.join(ROOT, "docs/07-master-backlog.xlsx");
const OUTPUT = path.join(ROOT, "docs/progress.md");
const SHEET = "03 · Master backlog";
const FIRST_DATA_ROW = 5;

const COL = { id: 1, sprint: 2, track: 3, epic: 4, item: 5, description: 6, days: 7, pri: 8, dependsOn: 9, ac: 10, status: 11 };

/**
 * Sprint groups for the "remaining work by block" section. The boundaries are
 * the plan's own: the three phases of the ladder, plus the two tracks that run
 * alongside it (WhatsApp, and the items deferred past MVP-1).
 */
const BLOCKS = [
  { name: "Foundation (W00)", sprints: ["W00"] },
  { name: "Answer surface (S01–S07)", sprints: ["S01", "S02", "S03", "S04", "S05", "S06", "S07"] },
  { name: "Staff + ops (S08–S10)", sprints: ["S08", "S09", "S10"] },
  { name: "Hardening + launch (S11–S13)", sprints: ["S11", "S12", "S13"] },
  { name: "WhatsApp track", sprints: ["WA"] },
  { name: "Deferred to MVP-1.5", sprints: ["DEF"] },
];

const STATUS_DONE = "✅";
const STATUS_PARTIAL = "🚧";
const STATUS_TODO = "☐";
/** The pre-glyph convention: "Done (PR #5 — ...)", "Done", "Done (2026-10-24)". */
const DONE_WORD_RE = /^done\b/i;
const TODO_WORD_RE = /^(not started|todo)\b/i;

function cellText(value) {
  if (value === null || value === undefined) return "";
  // exceljs returns rich text, hyperlinks and formulas as objects.
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
    if (typeof value.text === "string") return value.text;
    if (value.result !== undefined) return String(value.result);
  }
  return String(value);
}

function classify(status) {
  if (status.startsWith(STATUS_DONE) || DONE_WORD_RE.test(status)) return "done";
  if (status.startsWith(STATUS_PARTIAL)) return "partial";
  if (status.startsWith(STATUS_TODO) || TODO_WORD_RE.test(status)) return "todo";
  // Unknown vocabulary: fail rather than guess. A report that quietly counts a
  // finished item as "not started" is worse than no report.
  return null;
}

/** The sentence after the glyph, which is usually the blocker. */
function statusNote(status) {
  return status.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

async function readItems() {
  const wb = new Workbook();
  await wb.xlsx.readFile(WORKBOOK);
  const ws = wb.getWorksheet(SHEET);
  if (ws === undefined) throw new Error(`sheet "${SHEET}" not found in ${WORKBOOK}`);

  const items = [];
  for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const id = cellText(row.getCell(COL.id).value).trim();
    // A blank ID row is a spacer or a note; the workbook has both.
    if (id === "") continue;
    const days = Number(cellText(row.getCell(COL.days).value));
    const status = cellText(row.getCell(COL.status).value).trim();
    items.push({
      id,
      sprint: cellText(row.getCell(COL.sprint).value).trim(),
      epic: cellText(row.getCell(COL.epic).value).trim(),
      item: cellText(row.getCell(COL.item).value).trim(),
      days: Number.isFinite(days) ? days : 0,
      priority: cellText(row.getCell(COL.pri).value).trim(),
      status,
      state: classify(status),
      note: statusNote(status),
    });
  }
  if (items.length === 0) throw new Error("no backlog rows found — check the sheet name and first data row");

  const unknown = items
    .filter((item) => item.state === null)
    .map((item) => `${item.id}: "${item.status}"`);
  if (unknown.length > 0) {
    throw new Error(
      `unrecognised status vocabulary (expected ✅ / 🚧 / ☐, or a leading "Done"):\n  ${unknown.join("\n  ")}`,
    );
  }
  return items;
}

/** The previous report's snapshot, so the delta is measured against something real. */
async function readSnapshot() {
  try {
    const text = await readFile(OUTPUT, "utf8");
    const match = /<!-- progress-snapshot: (\{.*\}) -->/.exec(text);
    if (match === null) return null;
    const parsed = JSON.parse(match[1]);
    // A malformed snapshot would print NaN into the delta table, which looks
    // like data. Treat it as "no previous report" and say so instead.
    const valid =
      Number.isFinite(parsed?.items?.done) &&
      Number.isFinite(parsed?.items?.partial) &&
      Number.isFinite(parsed?.days?.done) &&
      Number.isFinite(parsed?.remainingDays) &&
      typeof parsed?.generatedAt === "string";
    return valid ? parsed : null;
  } catch {
    return null;
  }
}

const round = (n) => Math.round(n * 100) / 100;

function pct(part, whole) {
  return whole === 0 ? 0 : (part / whole) * 100;
}

function bar(percent, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function summarise(items) {
  const total = { items: items.length, days: round(items.reduce((sum, item) => sum + item.days, 0)) };
  const by = (state) => {
    const rows = items.filter((item) => item.state === state);
    return { items: rows.length, days: round(rows.reduce((sum, item) => sum + item.days, 0)) };
  };
  return { total, done: by("done"), partial: by("partial"), todo: by("todo") };
}

function sprintOrder(items) {
  const seen = [];
  for (const item of items) if (!seen.includes(item.sprint)) seen.push(item.sprint);
  return seen;
}

function sprintStats(items, sprint) {
  const rows = items.filter((item) => item.sprint === sprint);
  const totalDays = round(rows.reduce((sum, item) => sum + item.days, 0));
  const doneDays = round(rows.filter((r) => r.state === "done").reduce((sum, item) => sum + item.days, 0));
  const partialDays = round(rows.filter((r) => r.state === "partial").reduce((sum, item) => sum + item.days, 0));
  return {
    sprint,
    items: rows.length,
    doneItems: rows.filter((r) => r.state === "done").length,
    partialItems: rows.filter((r) => r.state === "partial").length,
    totalDays,
    doneDays,
    partialDays,
    // A partial item is counted at half its days for the second percentage: the
    // work exists, the AC is not met. Two numbers beat one fudged one.
    progress: pct(doneDays + partialDays / 2, totalDays),
  };
}

function blockStats(items) {
  return BLOCKS.map((block) => {
    const rows = items.filter((item) => block.sprints.includes(item.sprint));
    const totalDays = round(rows.reduce((sum, item) => sum + item.days, 0));
    const remainingDays = round(
      rows.filter((item) => item.state !== "done").reduce((sum, item) => sum + item.days, 0),
    );
    return {
      name: block.name,
      items: rows.length,
      remainingItems: rows.filter((item) => item.state !== "done").length,
      totalDays,
      remainingDays,
      doneDays: round(totalDays - remainingDays),
    };
  }).filter((block) => block.items > 0);
}

function deltaLine(label, before, after) {
  const diff = round(after - before);
  if (diff === 0) return `| ${label} | ${after} | — |`;
  const sign = diff > 0 ? "+" : "";
  return `| ${label} | ${after} | ${sign}${diff} |`;
}

function render(items, previous) {
  const sum = summarise(items);
  const order = sprintOrder(items);
  const overall = pct(sum.done.days, sum.total.days);
  const overallWithPartial = pct(sum.done.days + sum.partial.days / 2, sum.total.days);
  const inFlight = items.filter((item) => item.state === "partial");
  const blocks = blockStats(items);
  const remaining = round(blocks.reduce((acc, block) => acc + block.remainingDays, 0));
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16);

  const lines = [];
  lines.push("# Build progress");
  lines.push("");
  lines.push("<!-- GENERATED FILE — do not edit by hand.");
  lines.push("     Regenerate with `npm run progress` (scripts/progress.mjs).");
  lines.push(`     Source of truth for status: docs/07-master-backlog.xlsx, column K.`);
  lines.push("     Re-run this as part of every item's close-out (see the charter DoD). -->");
  lines.push("");
  lines.push(`_Generated ${generatedAt} UTC from the master backlog._`);
  lines.push("");

  lines.push("## Overall");
  lines.push("");
  lines.push("| Measure | Done | Of total | % |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| Items | ${sum.done.items} | ${sum.total.items} | ${round(pct(sum.done.items, sum.total.items))}% |`);
  lines.push(`| Days | ${sum.done.days} | ${sum.total.days} | ${round(overall)}% |`);
  lines.push("");
  lines.push("```");
  lines.push(`done            ${bar(overall)} ${overall.toFixed(1).padStart(5)}%`);
  lines.push(`+ half of 🚧    ${bar(overallWithPartial)} ${overallWithPartial.toFixed(1).padStart(5)}%`);
  lines.push("```");
  lines.push("");
  lines.push(
    `**${sum.partial.items} items in flight** (${sum.partial.days} d), **${sum.todo.items} not started** ` +
      `(${sum.todo.days} d), **${remaining} d remaining** in total.`,
  );
  lines.push("");
  lines.push(
    "> The second bar counts an in-flight item at half its days. It is a scheduling " +
      "estimate, not a status: an item with an unmet acceptance criterion is not done, " +
      "however much of its work exists.",
  );
  lines.push("");

  lines.push("## By sprint");
  lines.push("");
  lines.push("| Sprint | Items done | Days done | Days total | Progress |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const sprint of order) {
    const stats = sprintStats(items, sprint);
    lines.push(
      `| ${sprint} | ${stats.doneItems}/${stats.items}` +
        ` | ${stats.doneDays} | ${stats.totalDays} | \`${bar(stats.progress, 16)}\` ${round(stats.progress)}% |`,
    );
  }
  lines.push("");

  lines.push("## In flight");
  lines.push("");
  if (inFlight.length === 0) {
    lines.push("Nothing is in flight.");
  } else {
    lines.push("Every item whose cell starts with 🚧, with the reason recorded there.");
    lines.push("");
    lines.push("| ID | Sprint | Item | Days | Status note |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const item of inFlight) {
      lines.push(
        `| ${item.id} | ${item.sprint} | ${item.item.replace(/\|/g, "\\|")} | ${item.days} | ` +
          `${item.note.replace(/\|/g, "\\|") || "—"} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Remaining work by block");
  lines.push("");
  lines.push("| Block | Remaining items | Remaining days | Days total |");
  lines.push("| --- | --- | --- | --- |");
  for (const block of blocks) {
    lines.push(
      `| ${block.name} | ${block.remainingItems}/${block.items} | ${block.remainingDays} | ${block.totalDays} |`,
    );
  }
  lines.push("");

  lines.push("## Since the last report");
  lines.push("");
  if (previous === null) {
    lines.push(
      "No previous snapshot (this is the first generated report). Later runs compare against " +
        "the numbers in the HTML comment at the top of the previous file.",
    );
  } else {
    lines.push(`| Measure | Now | Change |`);
    lines.push("| --- | --- | --- |");
    lines.push(deltaLine("Items done", previous.items.done, sum.done.items));
    lines.push(deltaLine("Days done", previous.days.done, sum.done.days));
    lines.push(deltaLine("Items in flight", previous.items.partial, sum.partial.items));
    lines.push(deltaLine("Days remaining", previous.remainingDays, remaining));
    lines.push("");
    lines.push(`Previous report generated ${previous.generatedAt}.`);
  }
  lines.push("");

  lines.push("## How to read this");
  lines.push("");
  lines.push("- Statuses come from the workbook's Status column and nowhere else. `✅` = done,");
  lines.push("  `🚧` = partially delivered with a named blocker, `☐` = not started.");
  lines.push("- Days are the plan's estimates, not effort spent. A percentage here answers");
  lines.push("  \"how much of the plan is closed\", never \"how much time was used\".");
  lines.push("- The report is a snapshot of one commit. If it looks wrong, the workbook is");
  lines.push("  wrong — fix the workbook and re-run, do not edit this file.");
  lines.push("");

  const snapshot = {
    generatedAt,
    items: { done: sum.done.items, partial: sum.partial.items, todo: sum.todo.items, total: sum.total.items },
    days: { done: sum.done.days, partial: sum.partial.days, todo: sum.todo.days, total: sum.total.days },
    remainingDays: remaining,
    perSprint: Object.fromEntries(
      order.map((sprint) => {
        const stats = sprintStats(items, sprint);
        return [sprint, { doneItems: stats.doneItems, items: stats.items, doneDays: stats.doneDays, totalDays: stats.totalDays }];
      }),
    ),
  };

  // The snapshot goes at the very top so it survives even a partial read.
  return (
    `<!-- progress-snapshot: ${JSON.stringify(snapshot)} -->\n` + lines.join("\n")
  );
}

const items = await readItems();
const previous = await readSnapshot();
const markdown = render(items, previous);
await writeFile(OUTPUT, `${markdown}\n`, "utf8");

const sum = summarise(items);
process.stdout.write(
  `progress: ${sum.done.items}/${sum.total.items} items, ` +
    `${sum.done.days}/${sum.total.days} days (${round(pct(sum.done.days, sum.total.days))}%), ` +
    `${sum.partial.items} in flight -> ${path.relative(ROOT, OUTPUT)}\n`,
);
