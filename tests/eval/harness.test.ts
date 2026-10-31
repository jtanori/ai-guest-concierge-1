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
import type { AnswerStageEvent } from "../../src/ai/answer.ts";
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

/**
 * S06A-01 — the four things "retrieved nothing" used to mean, pinned apart.
 *
 * Each case exists because the old diagnostic collapsed them into one empty
 * list, and every one of them was being read as a content gap: a guardrail that
 * stopped the run before retrieval, a retrieval that really came back empty, a
 * model that declined after a healthy retrieval, and a verified fact that
 * answered before retrieval was asked.
 */
describe("eval harness — stage provenance", () => {
  /** The stages a healthy run crosses, up to the point under test. */
  const healthy = (
    retrieval: AnswerStageEvent,
    ...tail: AnswerStageEvent[]
  ): AnswerStageEvent[] => [
    { stage: "policy", status: "ok", detail: "allowed" },
    { stage: "sensitive", status: "ok" },
    { stage: "facts", status: "skip", detail: "no_structured_input" },
    retrieval,
    ...tail,
  ];

  it("does not count a pre-retrieval guardrail as a retrieval miss", () => {
    for (const [reasonCode, detail] of [
      ["sensitive_topic", "sensitive:allergens"],
      ["booking_intent", "sensitive:booking_intent"],
    ] as const) {
      const result = scoreEval([
        {
          question: question("answer", "wifi.info"),
          observed: "escalate",
          reasonCode,
          detail,
          stages: [
            { stage: "policy", status: "ok", detail: "allowed" },
            { stage: "sensitive", status: "stop", reasonCode, detail },
          ],
        },
      ]);
      expect(result.retrieval.checked).toBe(1);
      expect(result.retrieval.retrievalRun).toBe(0);
      expect(result.retrieval.matched).toBe(0);
      // The whole point: nothing was retrieved, so there is nothing to miss.
      expect(result.retrieval.misses).toHaveLength(0);
      expect(result.retrieval.notRunByStage).toEqual({ sensitive: 1 });
      // ... and the refusal still costs the answer it should.
      expect(result.scores.needlessEscalation).toBe(1);
    }
  });

  it("attributes a policy block to the stage that ended the run", () => {
    const result = scoreEval([
      {
        question: question("answer", "pool.hours"),
        observed: "escalate",
        reasonCode: "policy_block",
        detail: "mode_draft",
        stages: [{ stage: "policy", status: "stop", reasonCode: "policy_block", detail: "mode_draft" }],
      },
    ]);
    expect(result.retrieval.retrievalRun).toBe(0);
    expect(result.retrieval.misses).toHaveLength(0);
    expect(result.retrieval.notRunByStage).toEqual({ policy: 1 });
  });

  it("counts a true empty retrieval as a recall miss", () => {
    const result = scoreEval([
      {
        question: question("answer", "pets.policy"),
        observed: "no_answer",
        reasonCode: "low_retrieval",
        stages: healthy({
          stage: "retrieval",
          status: "ok",
          count: 0,
          topics: [],
          articleVersionIds: [],
        }),
      },
    ]);
    expect(result.retrieval.retrievalRun).toBe(1);
    expect(result.retrieval.matched).toBe(0);
    expect(result.retrieval.misses).toHaveLength(1);
    // An empty candidate list here means retrieval really was empty.
    expect(result.retrieval.misses[0]!.retrieved).toEqual([]);
    expect(result.retrieval.notRunByStage).toEqual({});
    expect(result.retrieval.rate).toBe(0);
  });

  it("reports candidate topics for a model no_answer after nonempty retrieval", () => {
    const stages = healthy(
      {
        stage: "retrieval",
        status: "ok",
        count: 2,
        topics: ["policy.quiet", "dining.menu"],
        articleVersionIds: ["11111111-1111-4111-8111-111111111111"],
      },
      { stage: "generate", status: "ok", modelId: "gemini-test", usedFallback: false },
      { stage: "contract", status: "ok" },
      { stage: "guardrail", status: "stop", reasonCode: "low_retrieval", detail: "not_an_answer" },
    );
    const result = scoreEval([
      { question: question("answer", "checkin.hours"), observed: "no_answer", reasonCode: "low_retrieval", stages },
      // The pipeline's own shape for a refusal: verifyAnswer refuses anything
      // that is not an answer, so a model `no_answer` reaches the harness as an
      // escalation with the same stage evidence behind it.
      { question: question("answer", "checkin.hours"), observed: "escalate", reasonCode: "low_retrieval", stages },
    ]);
    expect(result.retrieval.retrievalRun).toBe(2);
    expect(result.retrieval.misses).toHaveLength(2);
    expect(result.retrieval.misses[0]!.retrieved).toEqual(["policy.quiet", "dining.menu"]);
    expect(result.retrieval.misses[1]!.retrieved).toEqual(["policy.quiet", "dining.menu"]);
    expect(result.retrieval.notRunByStage).toEqual({});
  });

  it("keeps a verified fact out of the article-retrieval denominator", () => {
    const result = scoreEval([
      {
        question: question("answer", "pool.hours"),
        observed: "answer",
        reasonCode: null,
        answerTopics: ["pool.hours"],
        stages: [
          { stage: "policy", status: "ok", detail: "allowed" },
          { stage: "sensitive", status: "ok" },
          {
            stage: "facts",
            status: "ok",
            detail: "hit",
            topicKey: "pool.hours",
            factKey: "closing_time",
          },
        ],
      },
    ]);
    // The fact answered: correct, and not an article-retrieval observation.
    expect(result.counts.correct_answer).toBe(1);
    expect(result.retrieval.checked).toBe(1);
    expect(result.retrieval.retrievalRun).toBe(0);
    expect(result.retrieval.matched).toBe(0);
    expect(result.retrieval.misses).toHaveLength(0);
    expect(result.retrieval.notRunByStage).toEqual({ facts: 1 });
  });

  it("counts a retrieval hit as a hit", () => {
    const result = scoreEval([
      {
        question: question("answer", "pool.hours"),
        observed: "answer",
        reasonCode: null,
        answerTopics: ["pool.hours"],
        stages: healthy({
          stage: "retrieval",
          status: "ok",
          count: 1,
          topics: ["pool.hours"],
          articleVersionIds: ["22222222-2222-4222-8222-222222222222"],
        }),
      },
    ]);
    expect(result.retrieval).toMatchObject({ checked: 1, retrievalRun: 1, matched: 1, rate: 1 });
    expect(result.retrieval.misses).toHaveLength(0);
    expect(result.retrieval.notRunByStage).toEqual({});
  });

  it("keeps a provider outage in its own bucket, with retrieval still attributed", () => {
    const result = scoreEval([
      {
        question: question("answer", "pool.hours"),
        observed: "unavailable",
        reasonCode: null,
        stages: healthy(
          {
            stage: "retrieval",
            status: "ok",
            count: 1,
            topics: ["pool.hours"],
            articleVersionIds: ["33333333-3333-4333-8333-333333333333"],
          },
          { stage: "generate", status: "error", reasonCode: "provider_unavailable" },
        ),
      },
    ]);
    expect(result.counts.outage).toBe(1);
    expect(evaluateGate(result).breaches[0]).toMatchObject({ metric: "outage" });
    // Retrieval ran and found the target before the instrument failed; the
    // outage is the gate's problem, not a recall miss.
    expect(result.retrieval).toMatchObject({ retrievalRun: 1, matched: 1 });
    expect(result.retrieval.misses).toHaveLength(0);
    expect(result.retrieval.notRunByStage).toEqual({});
  });

  it("computes the same headline scores with and without stage provenance", () => {
    const base = (extra: Partial<JudgedQuestion> = {}): JudgedQuestion => ({
      question: question("answer", "pool.hours"),
      observed: "answer",
      reasonCode: null,
      topics: ["pool.hours"],
      answerTopics: ["pool.hours"],
      ...extra,
    });
    const without = scoreEval([base()]);
    const withStages = scoreEval([
      base({
        stages: [
          { stage: "policy", status: "ok", detail: "allowed" },
          { stage: "sensitive", status: "ok" },
          { stage: "facts", status: "skip", detail: "no_structured_input" },
          { stage: "retrieval", status: "ok", count: 1, topics: ["pool.hours"] },
          { stage: "guardrail", status: "ok" },
        ],
      }),
    ]);
    expect(withStages.scores).toEqual(without.scores);
    expect(withStages.counts).toEqual(without.counts);
    expect(withStages.retrieval).toMatchObject({
      checked: without.retrieval.checked,
      retrievalRun: without.retrieval.retrievalRun,
      matched: without.retrieval.matched,
      rate: without.retrieval.rate,
    });
  });

  it("still reads an explicit topic list as retrieval evidence on old fixtures", () => {
    // Rows built before the observer carry `topics` alone; an explicit list
    // (empty or not) came from retrieval, which is what it meant then.
    const ran = scoreEval([
      { question: question("answer", "wifi.info"), observed: "escalate", reasonCode: "low_retrieval", topics: [] },
    ]);
    expect(ran.retrieval.retrievalRun).toBe(1);
    expect(ran.retrieval.misses).toHaveLength(1);
    expect(ran.retrieval.notRunByStage).toEqual({});

    const neverBuilt = scoreEval([
      { question: question("answer", "wifi.info"), observed: "escalate", reasonCode: "policy_block" },
    ]);
    expect(neverBuilt.retrieval.retrievalRun).toBe(0);
    expect(neverBuilt.retrieval.misses).toHaveLength(0);
    expect(neverBuilt.retrieval.notRunByStage).toEqual({ unknown: 1 });
  });
});
