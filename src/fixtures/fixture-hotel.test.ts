import { describe, expect, it } from "vitest";
import {
  FIXTURE_ARTICLES,
  FIXTURE_FACTS,
  FIXTURE_PROPERTY,
  MESSY_CASES,
} from "./fixture-hotel.ts";

const byVersionId = (id: string) =>
  FIXTURE_ARTICLES.find((a) => a.articleVersionId === id);
const byCaseId = (id: string) =>
  MESSY_CASES.find((c) => c.id === id) as (typeof MESSY_CASES)[number] | undefined;

describe("W00-17 — the adversarial fixture hotel is reproducibly messy", () => {
  it("declares the demo property and carries all six messy cases", () => {
    expect(FIXTURE_PROPERTY.propertyId).toBe("demo");
    expect(MESSY_CASES).toHaveLength(6);
    for (const c of MESSY_CASES) {
      expect(byVersionId(c.articleVersionId), `case ${c.id}`).toBeDefined();
    }
  });

  it("case 1 — menu-flattened-two-column: dish+price pairs survive on shared lines", () => {
    const menu = byVersionId("1f0a2a3b-0001-4c01-a1a1-000000000001");
    expect(menu).toBeDefined();
    const body = menu?.body as string;
    const lines = body.split("\n");
    expect(lines.length).toBe(8); // 8 dishes flattened to 8 lines
    const pairs = lines.filter((l) => /\S {2,}\$\d+$/.test(l));
    expect(pairs.length).toBe(8); // every dish still lands with its price
  });

  it("case 2 — ocr-noise-scan: text carries digit-for-letter substitutions", () => {
    const scan = byVersionId("1f0a2a3b-0002-4c01-a1a1-000000000002");
    const body = (scan?.body as string) ?? "";
    expect(body).toMatch(/Ch[ée]ck[-\s]?[o0]ut/i);
    expect(body).toMatch(/fr0m|res3ct|qu1et|P4rties|rûles/);
  });

  it("case 3 — contradiction-pool-hours: two facts, one topic, different values", () => {
    const poolFacts = FIXTURE_FACTS.filter((f) => f.topicKey === "pool.hours");
    expect(poolFacts).toHaveLength(2);
    const values = new Set(poolFacts.map((f) => f.value));
    expect(values.size).toBe(2); // 21:00 vs 20:00 — an unresolved contradiction
    expect(values.has("21:00")).toBe(true);
    expect(values.has("20:00")).toBe(true);
    // Distinct sources, same language, same unit, neither verified
    expect(new Set(poolFacts.map((f) => f.sourceArticleVersionId)).size).toBe(2);
    expect(poolFacts.every((f) => !f.verified)).toBe(true);
    expect(poolFacts.every((f) => f.unit === "time-of-day")).toBe(true);
  });

  it("case 4 — spa-prices-foreign-language: fact language (fr) differs from article body (es)", () => {
    const spaArticle = byVersionId("1f0a2a3b-0005-4c01-a1a1-000000000005");
    expect(spaArticle?.language).toBe("es");
    const spaFacts = FIXTURE_FACTS.filter(
      (f) => f.sourceArticleVersionId === spaArticle?.articleVersionId,
    );
    expect(spaFacts.length).toBeGreaterThanOrEqual(2);
    expect(spaFacts.every((f) => f.language === "fr")).toBe(true);
  });

  it("case 5 — marketing-fact-buried-paragraph-11: ≥3,000 words, fact in paragraph 11", () => {
    const marketing = byVersionId("1f0a2a3b-0006-4c01-a1a1-000000000006");
    const body = marketing?.body as string;
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeGreaterThanOrEqual(3000);

    const paragraphs = body.split("\n\n");
    expect(paragraphs.length).toBeGreaterThanOrEqual(11);
    expect(
      (paragraphs[0] as string).startsWith("Welcome to Casa Mesa"),
    ).toBe(true);
    const para11 = paragraphs[10] as string;
    expect(para11).toContain("gym.hours");
    expect(para11).toContain("24/7");
    // The fact appears exactly once, and not before paragraph 11
    expect(body.lastIndexOf("24/7")).toBe(body.indexOf("24/7"));
    expect(body.indexOf("24/7")).toBeGreaterThan(
      body.indexOf(paragraphs[9] as string),
    );
  });

  it("case 6 — noticeboard-picture-only: no text to chunk, still a citable version", () => {
    const notice = byVersionId("1f0a2a3b-0007-4c01-a1a1-000000000007");
    expect(notice?.body).toBeNull();
    expect(notice?.isCurrent).toBe(true);
    expect(notice?.articleVersionId).toBeDefined();
  });

  it("D5 — every fact resolves to an existing article VERSION, never an article row", () => {
    const versionIds = new Set(FIXTURE_ARTICLES.map((a) => a.articleVersionId));
    expect(FIXTURE_FACTS.length).toBeGreaterThan(0);
    for (const f of FIXTURE_FACTS) {
      expect(versionIds.has(f.sourceArticleVersionId), f.factId).toBe(true);
      expect(f.propertyId).toBe("demo");
    }
  });

  it("all fixture cases are declared in MESSY_CASES with a reproducibility note", () => {
    const declaredIds = MESSY_CASES.map((c) => byCaseId(c.id)?.id);
    expect(declaredIds.filter(Boolean)).toHaveLength(6);
    for (const c of MESSY_CASES) {
      expect(c.whatBreaks.length).toBeGreaterThan(20);
    }
  });
});
