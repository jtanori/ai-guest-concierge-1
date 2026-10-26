/**
 * S05-01 — AC-1: malformed output is rejected server-side, never sent.
 *
 * Each case here is a real failure mode of a provider that was asked for JSON:
 * a truncated string, a decision nobody defined, an answer with no citation, a
 * citation the retrieval never produced, a confidence of 1.4, an invented
 * reason code. Every one must throw, and the message must name the field —
 * a rejection that says only "invalid" is unoperable at 2am.
 */
import { describe, expect, it } from "vitest";
import {
  AiContractError,
  isSendable,
  parseAiOutput,
  toRunDecision,
  type AiOutput,
  type ParseContext,
} from "../../src/ai/contract.ts";
import { buildPrompt, promptArticlesFromHits, PROMPT_VERSION } from "../../src/ai/prompt.ts";
import type { RetrievalHit } from "../../src/knowledge/retrieval.ts";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";

const context: ParseContext = {
  allowedVersionIds: [V1, V2],
  allowedTopicKeys: ["pool.hours", "wifi.access"],
};

function valid(): Record<string, unknown> {
  return {
    decision: "answer",
    answer: "La alberca cierra a las 20:00.",
    language: "es-MX",
    citations: [{ article_version_id: V1, quote: "cierra a las 20:00" }],
    reason_code: null,
    topic_keys_used: ["pool.hours"],
    confidence: 0.86,
  };
}

function rejects(mutate: (value: Record<string, unknown>) => void, ...fragments: string[]): void {
  const value = valid();
  mutate(value);
  try {
    parseAiOutput(value, context);
    throw new Error("expected AiContractError");
  } catch (error) {
    expect(error).toBeInstanceOf(AiContractError);
    const message = (error as Error).message;
    for (const fragment of fragments) expect(message).toContain(fragment);
  }
}

describe("AI output contract", () => {
  it("accepts a well-formed answer and normalizes it", () => {
    const output: AiOutput = parseAiOutput(valid(), context);
    expect(output).toEqual({
      decision: "answer",
      answer: "La alberca cierra a las 20:00.",
      language: "es-MX",
      citations: [{ articleVersionId: V1, quote: "cierra a las 20:00" }],
      reasonCode: null,
      topicKeysUsed: ["pool.hours"],
      confidence: 0.86,
    });
    expect(isSendable(output)).toBe(true);
    expect(toRunDecision(output.decision)).toBe("answer");
  });

  it("rejects a truncated JSON string and a non-object", () => {
    expect(() => parseAiOutput('{"decision":"answer","answer":"La alb', context)).toThrow(
      /not JSON/,
    );
    expect(() => parseAiOutput(42, context)).toThrow(/not a JSON object/);
    expect(() => parseAiOutput(null, context)).toThrow(/not a JSON object/);
  });

  it("unwraps the string and the single-element array providers actually send", () => {
    expect(parseAiOutput(JSON.stringify(valid()), context).decision).toBe("answer");
    expect(parseAiOutput([valid()], context).decision).toBe("answer");
  });

  it("rejects an unknown decision, a missing field and an extra field", () => {
    rejects((v) => (v["decision"] = "maybe"), 'decision must be one of answer | needs_human | no_answer');
    rejects((v) => delete v["confidence"], 'missing field "confidence"');
    rejects((v) => (v["model"] = "gpt-4o"), 'unknown field "model"');
  });

  it("rejects an answer with no citations, and a citation outside the retrieved set", () => {
    rejects((v) => (v["citations"] = []), "requires at least one citation");
    rejects(
      (v) => (v["citations"] = [{ article_version_id: STRANGER, quote: "something" }]),
      "was not retrieved for this turn",
    );
    rejects(
      (v) => (v["citations"] = [{ article_version_id: "not-a-uuid", quote: "x" }]),
      "is not a uuid",
    );
    rejects((v) => (v["citations"] = [{ article_version_id: V1 }]), "quote must be a non-empty string");
  });

  it("rejects an out-of-range or non-numeric confidence", () => {
    rejects((v) => (v["confidence"] = 1.4), "within 0..1");
    rejects((v) => (v["confidence"] = -0.1), "within 0..1");
    rejects((v) => (v["confidence"] = "0.9"), "confidence must be a number");
  });

  it("rejects an unknown reason_code and a reason_code on an answer", () => {
    rejects(
      (v) => {
        v["decision"] = "needs_human";
        v["answer"] = null;
        v["citations"] = [];
        v["reason_code"] = "made_up";
      },
      "reason_code must be one of low_retrieval",
    );
    rejects((v) => (v["reason_code"] = "low_retrieval"), "reason_code must be null");
  });

  it("refuses prose attached to a non-answer (the leak this contract exists for)", () => {
    rejects(
      (v) => {
        v["decision"] = "no_answer";
        v["citations"] = [];
      },
      'answer must be null unless decision is "answer"',
    );
  });

  it("maps needs_human to the table's escalate without changing the model's word", () => {
    const output = parseAiOutput(
      {
        decision: "needs_human",
        answer: null,
        language: "es",
        citations: [],
        reason_code: "booking_intent",
        topic_keys_used: [],
        confidence: 0.4,
      },
      context,
    );
    expect(output.decision).toBe("needs_human");
    expect(toRunDecision(output.decision)).toBe("escalate");
    expect(isSendable(output)).toBe(false);
  });

  it("rejects a bad language tag and an over-long answer", () => {
    rejects((v) => (v["language"] = "Spanish"), "BCP-47");
    rejects((v) => (v["answer"] = "x".repeat(1201)), "answer exceeds 1200 characters");
  });

  it("rejects a topic key that was not retrieved, and de-duplicates the ones that were", () => {
    rejects((v) => (v["topic_keys_used"] = ["spa.hours"]), "was not retrieved for this turn");
    const value = valid();
    value["topic_keys_used"] = ["pool.hours", "pool.hours"];
    expect(parseAiOutput(value, context).topicKeysUsed).toEqual(["pool.hours"]);
  });

  it("reports every violation at once, not just the first", () => {
    try {
      parseAiOutput({ decision: "answer" }, context);
      throw new Error("expected AiContractError");
    } catch (error) {
      expect(error).toBeInstanceOf(AiContractError);
      expect((error as AiContractError).violations.length).toBeGreaterThan(3);
    }
  });
});

describe("prompt contract", () => {
  const hits = [
    {
      articleVersionId: V1,
      articleId: "44444444-4444-4444-8444-444444444444",
      topicKey: "pool.hours",
      title: "Alberca",
      body: "BODY ".repeat(600),
      language: "es",
      versionNo: 1,
      score: 0.5,
      scope: "property" as const,
      matchedChunk: { chunkId: "c1", ordinal: 0, body: "La alberca cierra a las 20:00." },
    },
  ] satisfies RetrievalHit[];

  it("is versioned and exposes the matched chunk rather than the whole body", () => {
    expect(PROMPT_VERSION).toBe("answer-v1");
    const [article] = promptArticlesFromHits(hits);
    expect(article!.text).toBe("La alberca cierra a las 20:00.");
  });

  it("labels every article with the version id a citation must use, and no article id", () => {
    const { system, prompt } = buildPrompt({
      question: "¿A qué hora cierra la alberca?",
      propertyLanguage: "es-MX",
      tone: "friendly",
      articles: promptArticlesFromHits(hits),
    });
    expect(prompt).toContain(`article_version_id=${V1}`);
    expect(prompt).not.toContain("44444444-4444-4444-8444-444444444444");
    expect(system).toContain("Never guess");
    // The no-answer path is offered, not hidden: the false-answer rate is the gate.
    expect(system).toContain("no_answer");
  });

  it("says so explicitly when nothing was retrieved", () => {
    const { prompt } = buildPrompt({
      question: "Is there a helipad?",
      propertyLanguage: "en",
      tone: "formal",
      articles: [],
    });
    expect(prompt).toContain("none were retrieved");
  });

  it("refuses an empty question instead of prompting with nothing", () => {
    expect(() =>
      buildPrompt({ question: "  ", propertyLanguage: "es", tone: "friendly", articles: [] }),
    ).toThrow(RangeError);
  });
});
