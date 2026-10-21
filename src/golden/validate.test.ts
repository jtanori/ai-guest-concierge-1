import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCsv,
  validateGoldenQuestions,
  type GoldenQuestion,
} from "./validate.ts";

const GOLDEN_FILE = path.resolve(
  import.meta.dirname,
  "../../data/golden/golden-questions-v1.csv",
);

const opts = { minRows: 20, propertyLanguages: ["es", "en"] as const };

describe("W00-15 — golden set v1 (shipped file)", () => {
  it("parses and satisfies every format rule", () => {
    const text = readFileSync(GOLDEN_FILE, "utf8");
    const questions = validateGoldenQuestions(text, opts);
    expect(questions).toHaveLength(20);
  });

  it("is balanced for the false-answer gate: both languages, enough escalation", () => {
    const text = readFileSync(GOLDEN_FILE, "utf8");
    const questions: GoldenQuestion[] = validateGoldenQuestions(text, opts);
    const escalations = questions.filter((q) => q.expected === "escalate");
    expect(escalations.length).toBeGreaterThanOrEqual(5); // ≥25%
    expect(escalations.length).toBeGreaterThanOrEqual(7); // ~⅓ as authored
    expect(questions.filter((q) => q.language === "es").length).toBeGreaterThanOrEqual(6);
    expect(questions.filter((q) => q.language === "en").length).toBeGreaterThanOrEqual(6);
  });

  it("answers cite structured topics; escalations never do", () => {
    const text = readFileSync(GOLDEN_FILE, "utf8");
    for (const q of validateGoldenQuestions(text, opts)) {
      if (q.expected === "answer") {
        expect(q.targetTopic, q.question).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      } else {
        expect(q.targetTopic, q.question).toBeNull();
      }
    }
  });

  it("the appendix-A seed rows are present verbatim", () => {
    const text = readFileSync(GOLDEN_FILE, "utf8");
    expect(text).toContain("¿A qué hora cierra la alberca?,answer,pool.hours");
    expect(text).toContain("Can I bring my dog?,answer,policy.pets");
    expect(text).toContain("Do you have a room available for tonight?,escalate");
    expect(text).toContain("Quiero cancelar y que me devuelvan el dinero,escalate");
    expect(text).toContain("wheelchair-accessible room for our stay,escalate");
  });
});

describe("validator rejects malformed sets", () => {
  const base = [
    "property_id,language,question,expected_behaviour,target_topic,notes",
    'demo,en,Do you have a room for tonight?,escalate,,"no availability"',
  ].join("\n");

  it("rejects a wrong header", () => {
    expect(() =>
      validateGoldenQuestions("wrong,header\nx", opts),
    ).toThrow(/header must be/);
  });

  it("rejects an unknown expected_behaviour", () => {
    const bad = `${base}\ndemo,es,Question here,predict,pool.hours,note`;
    expect(() => validateGoldenQuestions(bad, opts)).toThrow(/expected_behaviour/);
  });

  it("rejects answer rows without a topic", () => {
    const bad = `${base}\ndemo,es,Pool hours?,answer,,fact`;
    expect(() => validateGoldenQuestions(bad, opts)).toThrow(/target_topic/);
  });

  it("rejects escalation rows with a topic (they are the no-KB cases)", () => {
    const bad = `${base}\ndemo,es,Refund please,escalate,policy.refund,note`;
    expect(() => validateGoldenQuestions(bad, opts)).toThrow(
      /escalation cases do not name a topic/,
    );
  });

  it("rejects escalate rows without a hand-written note", () => {
    const bad = `${base}\ndemo,es,Ayuda,escalate,,`;
    expect(() => validateGoldenQuestions(bad, opts)).toThrow(/hand-written note/);
  });

  it("rejects a language outside the property's languages", () => {
    const bad = `${base}\ndemo,fr,Excusez-moi le hors-piscine?,escalate,,note`;
    expect(() => validateGoldenQuestions(bad, { ...opts })).toThrow(/language/);
  });

  it("rejects a too-small set", () => {
    expect(() => validateGoldenQuestions(base, opts)).toThrow(/minimum is 20/);
  });

  it("rejects a KB-biased set (escalation share below 25%)", () => {
    const rows = ["property_id,language,question,expected_behaviour,target_topic,notes"];
    for (let i = 1; i <= 20; i++) {
      rows.push(`demo,en,q${i},answer,topic.one,note${i}`);
    }
    expect(() =>
      validateGoldenQuestions(rows.join("\n"), opts),
    ).toThrow(/escalation share/);
  });

  it("parses quoted fields and escaped quotes per RFC-4180", () => {
    const csv = 'a,b\n"1,000","say ""hi"""';
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["1,000", 'say "hi"'],
    ]);
  });
});
