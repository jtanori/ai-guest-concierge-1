/**
 * S06-03 — the gate's own tests.
 *
 * A threshold nobody tested at its boundary is a number, not a control. These
 * cases pin the two things that can silently invert a gate: the bucket a
 * failure lands in, and the direction of the comparison (2.01% must fail a 2%
 * cap; 2.00% must pass it).
 */
import { describe, expect, it } from "vitest";
import {
  classifyJudgement,
  compareToBaseline,
  evaluateGate,
  formatPercent,
  scoreEval,
  type EvalBaseline,
  type JudgedQuestion,
  type ObservedDecision,
} from "../../src/eval/harness.ts";
import { FALSE_ANSWER_MAX, MIN_QUESTIONS_FOR_GATE } from "../../src/eval/thresholds.ts";
import type { ExpectedBehaviour, GoldenQuestion } from "../../src/golden/validate.ts";

let sequence = 0;

function question(
  expected: ExpectedBehaviour,
  targetTopic: string | null = null,
): GoldenQuestion {
  sequence += 1;
  return {
    propertyId: "demo",
    language: "en",
    question: `question ${sequence}`,
    expected,
    targetTopic,
    notes: expected === "answer" ? "fixture" : "fixture escalation",
  };
}

function row(
  expected: ExpectedBehaviour,
  observed: ObservedDecision,
  extra: Partial<JudgedQuestion> = {},
): JudgedQuestion {
  return {
    question: extra.question ?? question(expected, expected === "answer" ? "pool.hours" : null),
    observed,
    reasonCode: extra.reasonCode ?? null,
    ...extra,
  };
}

describe("eval harness — classification", () => {
  it("puts each of the four outcomes in its own bucket", () => {
    expect(classifyJudgement("answer", "answer", { targetTopic: "pool.hours", answerTopics: ["pool.hours"] })).toBe(
      "correct_answer",
    );
    expect(classifyJudgement("escalate", "escalate")).toBe("correct_escalation");
    expect(classifyJudgement("escalate", "answer")).toBe("false_answer");
    expect(classifyJudgement("answer", "escalate")).toBe("needless_escalation");
  });

  it("counts the model's own no_answer as a needless escalation, never a false answer", () => {
    // An honest "I don't know" must not be punished as if it were an invented
    // fact, or the cheapest way to pass the gate is to stop answering.
    expect(classifyJudgement("answer", "no_answer")).toBe("needless_escalation");
    expect(classifyJudgement("escalate", "no_answer")).toBe("correct_escalation");
  });

  it("calls an answer to a different question a false answer", () => {
    // The citation is real and the guardrail passes: this is the failure mode
    // target_topic exists to catch.
    expect(
      classifyJudgement("answer", "answer", {
        targetTopic: "checkin.hours",
        answerTopics: ["policy.quiet"],
      }),
    ).toBe("false_answer");
    // ... and it is recorded as such, with both topics, so the finding names
    // what happened rather than leaving a bare count.
    const result = scoreEval([
      {
        question: question("answer", "checkin.hours"),
        observed: "answer",
        reasonCode: null,
        answerTopics: ["policy.quiet"],
      },
    ]);
    expect(result.outcomes[0]?.offTopic).toEqual({
      target: "checkin.hours",
      answered: ["policy.quiet"],
    });
  });

  it("does not punish an answer when the golden set names no topic to check", () => {
    expect(classifyJudgement("answer", "answer", { targetTopic: null, answerTopics: [] })).toBe(
      "correct_answer",
    );
    expect(classifyJudgement("answer", "answer", {})).toBe("correct_answer");
  });

  it("counts an outage as an outage, in every bucket", () => {
    expect(classifyJudgement("answer", "unavailable")).toBe("outage");
    expect(classifyJudgement("escalate", "unavailable")).toBe("outage");
  });
});

describe("eval harness — scoring", () => {
  it("scores a mixed run against its own denominators", () => {
    const result = scoreEval([
      row("answer", "answer"),
      row("answer", "answer"),
      row("answer", "no_answer"),
      row("escalate", "escalate"),
      row("escalate", "answer"),
    ]);
    expect(result.total).toBe(5);
    expect(result.answerExpected).toBe(3);
    expect(result.escalationExpected).toBe(2);
    expect(result.counts).toMatchObject({
      correct_answer: 2,
      correct_escalation: 1,
      false_answer: 1,
      needless_escalation: 1,
      outage: 0,
    });
    expect(result.scores.falseAnswer).toBeCloseTo(0.2, 10);
    // (2 + 1) / 5
    expect(result.scores.correctOrEscalation).toBeCloseTo(0.6, 10);
    // 1 of the 2 escalation-expected rows
    expect(result.scores.correctEscalation).toBeCloseTo(0.5, 10);
    // 1 of the 3 answerable rows
    expect(result.scores.needlessEscalation).toBeCloseTo(1 / 3, 10);
    expect(result.misses).toHaveLength(2);
  });

  it("treats an empty denominator as undefined, not as zero", () => {
    const noEscalations = scoreEval([row("answer", "answer"), row("answer", "answer")]);
    expect(noEscalations.scores.correctEscalation).toBe(1);
    expect(noEscalations.scores.needlessEscalation).toBe(0);
    expect(evaluateGate(noEscalations).breaches).toEqual([]);
  });

  it("tracks whether the target topic actually reached the answer", () => {
    const result = scoreEval([
      {
        question: question("answer", "pool.hours"),
        observed: "answer",
        reasonCode: null,
        topics: ["pool.hours", "dining.menu"],
        answerTopics: ["pool.hours"],
      },
      {
        question: question("answer", "wifi.info"),
        observed: "escalate",
        reasonCode: "low_retrieval",
        topics: [],
      },
      // A missing target_topic is a data problem the validator already refuses;
      // the harness must degrade instead of throwing.
      { question: question("answer", null), observed: "no_answer", reasonCode: "low_retrieval" },
    ]);
    expect(result.retrieval.checked).toBe(2);
    expect(result.retrieval.matched).toBe(1);
    expect(result.retrieval.rate).toBe(0.5);
    expect(result.retrieval.misses[0]?.targetTopic).toBe("wifi.info");
  });

  it("formats rates the way the runbook reads them", () => {
    expect(formatPercent(0.0201)).toBe("2.0%");
    expect(formatPercent(1)).toBe("100.0%");
  });
});

describe("eval harness — the absolute gate", () => {
  /** `falseAnswers` wrong answers inside a set of `total` escalation-expected rows. */
  function synthetic(total: number, falseAnswers: number): JudgedQuestion[] {
    return Array.from({ length: total }, (_, index) =>
      row("escalate", index < falseAnswers ? "answer" : "escalate"),
    );
  }

  it("passes at exactly the cap (4 of 200 = 2.00%)", () => {
    const result = scoreEval(synthetic(200, 4));
    expect(result.scores.falseAnswer).toBe(FALSE_ANSWER_MAX);
    expect(evaluateGate(result).breaches.map((breach) => breach.metric)).not.toContain("falseAnswer");
    expect(evaluateGate(result).pass).toBe(true);
  });

  it("fails above the cap (4 of 199 = 2.01%)", () => {
    const result = scoreEval(synthetic(199, 4));
    expect(result.scores.falseAnswer).toBeGreaterThan(FALSE_ANSWER_MAX);
    const verdict = evaluateGate(result);
    expect(verdict.pass).toBe(false);
    expect(verdict.breaches.map((breach) => breach.metric)).toContain("falseAnswer");
  });

  it("fails on an outage even when every score looks perfect", () => {
    const verdict = evaluateGate(scoreEval([row("answer", "answer"), row("answer", "unavailable")]));
    expect(verdict.pass).toBe(false);
    expect(verdict.breaches[0]).toMatchObject({ metric: "outage" });
  });

  it("says out loud when the set is too small to express a 2% cap", () => {
    const verdict = evaluateGate(scoreEval(synthetic(20, 0)));
    expect(verdict.armed).toBe(false);
    expect(verdict.note).toContain("20 questions");
    expect(evaluateGate(scoreEval(synthetic(MIN_QUESTIONS_FOR_GATE, 0))).armed).toBe(true);
  });
});

describe("eval harness — the regression gate", () => {
  /**
   * A run with a known shape: `answered` answer-expected rows answered,
   * `needless` answer-expected rows refused, `escalated` escalation-expected
   * rows escalated, `falseAnswers` escalation-expected rows answered.
   */
  function run(
    answered: number,
    needless: number,
    escalated: number,
    falseAnswers: number,
  ): JudgedQuestion[] {
    return [
      ...Array.from({ length: answered }, () => row("answer", "answer")),
      ...Array.from({ length: needless }, () => row("answer", "no_answer")),
      ...Array.from({ length: escalated }, () => row("escalate", "escalate")),
      ...Array.from({ length: falseAnswers }, () => row("escalate", "answer")),
    ];
  }

  const baselineResult = scoreEval(run(60, 0, 30, 10));
  const baseline: EvalBaseline = {
    goldenFile: "golden.csv",
    total: baselineResult.total,
    counts: baselineResult.counts,
    scores: baselineResult.scores,
  };

  it("passes an identical run", () => {
    expect(compareToBaseline(scoreEval(run(60, 0, 30, 10)), baseline)).toEqual([]);
  });

  it("fails a worse false-answer rate", () => {
    const breaches = compareToBaseline(scoreEval(run(60, 0, 29, 11)), baseline);
    expect(breaches.map((breach) => breach.metric)).toContain("falseAnswer");
  });

  it("fails a lower correct-or-escalation rate", () => {
    // Same false-answer rate, one answerable question refused instead: a
    // regression the false-answer clause cannot see.
    const breaches = compareToBaseline(scoreEval(run(59, 1, 30, 10)), baseline);
    const metrics = breaches.map((breach) => breach.metric);
    expect(metrics).toContain("correctOrEscalation");
    // A refusal also shows up as needless escalation — two readings of one
    // regression, which is why both clauses exist.
    expect(metrics).toContain("needlessEscalation");
    expect(metrics).not.toContain("falseAnswer");
  });

  it("fails a quietly shrunken golden set", () => {
    const breaches = compareToBaseline(scoreEval(run(54, 0, 27, 9)), baseline);
    expect(breaches[0]).toMatchObject({ metric: "question_count", relation: "equal" });
  });
});
