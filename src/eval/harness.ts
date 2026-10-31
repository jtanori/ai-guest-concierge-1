/**
 * S06-03 — the scorer.
 *
 * A pure function over (expected behaviour, observed decision) pairs. It is
 * deliberately not wired to a database, a provider or a clock: the numbers the
 * gate acts on must be computable from a fixture, so the gate itself can be
 * tested at its boundaries instead of being trusted because it ran.
 *
 * The four buckets, and why each one is a different product failure:
 *
 *   correct_answer      — answered, and the golden set says it can be.
 *   correct_escalation  — a human was needed, and one was asked for.
 *   false_answer        — **answered when a human was needed.** This is the
 *                         dangerous one: it is the only bucket that can put a
 *                         confident wrong statement in front of a guest, and it
 *                         is the one G2 caps at 2%.
 *   needless_escalation — a human was *not* needed. Costs containment (the
 *                         north star), never trust.
 *
 * `no_answer` (nothing retrieved, or the model declined) counts as a needless
 * escalation, not a false answer: the guest got "I don't know", which is
 * useless but honest. Collapsing it into `false_answer` would make the gate
 * punish honesty, and a gate that punishes honesty gets switched off.
 *
 * A provider outage is neither: it is the instrument being broken, so it is
 * counted separately and it always fails the run. A harness that reports "0%
 * false answers" because it could not reach a model is lying.
 */
import type { GoldenQuestion } from "../golden/validate.ts";
import type { AnswerStageEvent } from "../ai/answer.ts";
import { MIN_QUESTIONS_FOR_GATE, THRESHOLDS, type Thresholds } from "./thresholds.ts";

export const OBSERVED_DECISIONS = ["answer", "escalate", "no_answer", "unavailable"] as const;
export type ObservedDecision = (typeof OBSERVED_DECISIONS)[number];

/** One golden question, after the pipeline ran on it. */
export interface JudgedQuestion {
  question: GoldenQuestion;
  observed: ObservedDecision;
  /** `reason_code` from the pipeline, when it gave one. Never invented here. */
  reasonCode: string | null;
  /** Human-readable cause, e.g. `sensitive:allergen` or `guard:ungrounded_quote`. */
  detail?: string;
  /** Topic keys the retrieval actually returned, for the diagnostic below. */
  topics?: readonly string[];
  /** Topic keys the *answer* used, i.e. what it cited. Scoring, not diagnostics. */
  answerTopics?: readonly string[];
  /**
   * S06A-01: stage provenance from the pipeline's eval-only observer. When it is
   * present it — not `topics` — is what says whether retrieval ran. Absent on
   * hand-built fixtures, which then fall back to `topics !== undefined`.
   */
  stages?: readonly AnswerStageEvent[];
}

export const BUCKETS = [
  "correct_answer",
  "correct_escalation",
  "false_answer",
  "needless_escalation",
  "outage",
] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface JudgedOutcome extends JudgedQuestion {
  bucket: Bucket;
  expected: GoldenQuestion["expected"];
  /** Set when a `false_answer` was an answer to a *different* question. */
  offTopic?: { target: string; answered: readonly string[] };
}

export interface EvalScores {
  /** false_answer / total. G2 cap: ≤2%. */
  falseAnswer: number;
  /** (correct_answer + correct_escalation) / total. G2 floor: ≥95%. */
  correctOrEscalation: number;
  /** correct_escalation / escalation-expected. Floor: ≥90%. */
  correctEscalation: number;
  /** needless_escalation / answer-expected. Cap: ≤20%. */
  needlessEscalation: number;
}

/**
 * Target-topic recall, with the denominator it was computed over.
 *
 * Four states that the old diagnostic collapsed into one, because they mean
 * four different things:
 *
 *   matched        — retrieval ran and returned the target topic.
 *   misses         — retrieval ran and did NOT return it: a real content gap,
 *                    the only bucket "retrieved nothing" is allowed to imply.
 *   notRunByStage  — retrieval never ran; keyed by the stage that ended the
 *                    run (a guardrail, a policy block, a verified fact). Not a
 *                    retrieval miss: nothing was retrieved *to* miss.
 *   outage         — the instrument failed; `EvalResult.counts.outage` and the
 *                    gate already carry that, separately from all of the above.
 */
export interface RetrievalDiagnostic {
  /** Answer-expected rows with a `target_topic`: the coverage denominator. */
  checked: number;
  /** Of those, the rows where article retrieval actually executed. */
  retrievalRun: number;
  matched: number;
  /** matched / retrievalRun — recall over the rows where retrieval ran. */
  rate: number;
  /** Rows where retrieval did not run, by the stage that ended the pipeline. */
  notRunByStage: Record<string, number>;
  misses: Array<{
    question: string;
    language: string;
    targetTopic: string | null;
    /** What retrieval returned; empty here means retrieval really was empty. */
    retrieved: readonly string[];
  }>;
}

export interface EvalResult {
  total: number;
  answerExpected: number;
  escalationExpected: number;
  counts: Record<Bucket, number>;
  scores: EvalScores;
  outcomes: JudgedOutcome[];
  /** Every row that was not a correct answer or correct escalation. */
  misses: JudgedOutcome[];
  retrieval: RetrievalDiagnostic;
}

export interface ClassificationContext {
  targetTopic?: string | null;
  /** What the answer actually cited, when it answered. */
  answerTopics?: readonly string[];
}

/**
 * The whole classification rule, in one place.
 *
 * The off-topic case is the one a citation check cannot see. `verifyAnswer`
 * proves a quote exists in the article it names — it cannot prove the article
 * was *about the guest's question*. So a check-in question answered from the
 * check-out line of the quiet-hours policy passes every guardrail and is still a
 * false answer, and the golden set's `target_topic` is the only label that can
 * catch it. Scoring it as correct would measure whether the bot said something.
 */
export function classifyJudgement(
  expected: GoldenQuestion["expected"],
  observed: ObservedDecision,
  context: ClassificationContext = {},
): Bucket {
  if (observed === "unavailable") return "outage";
  if (expected === "answer") {
    if (observed !== "answer") return "needless_escalation";
    const target = context.targetTopic ?? null;
    const answered = context.answerTopics ?? [];
    if (target !== null && answered.length > 0 && !answered.includes(target)) {
      return "false_answer";
    }
    return "correct_answer";
  }
  // `escalate` and `refuse` are the same thing to the pipeline: a human, or an
  // honest "I don't know". Anything that actually answered is a false answer.
  return observed === "answer" ? "false_answer" : "correct_escalation";
}

/**
 * Did article retrieval execute for this row?
 *
 * Stage provenance is authoritative when the pipeline produced it. The
 * `topics !== undefined` fallback exists only for hand-built fixtures that
 * predate the observer, and preserves their old meaning: an explicit topic list
 * (including an empty one) came from retrieval.
 */
function retrievalRan(row: JudgedQuestion): boolean {
  if (row.stages !== undefined) return row.stages.some((event) => event.stage === "retrieval");
  return row.topics !== undefined;
}

/** The candidate topics retrieval returned, from the trace when there is one. */
function candidateTopics(row: JudgedQuestion): readonly string[] {
  if (row.stages !== undefined) {
    return row.stages.find((event) => event.stage === "retrieval")?.topics ?? [];
  }
  return row.topics ?? [];
}

/**
 * The stage the run ended on: the last one it crossed. For a pre-retrieval
 * escalation that is the guardrail that stopped it; for a verified fact it is
 * `facts`, which is the stage that produced the answer.
 */
function endedAt(row: JudgedQuestion): string | null {
  const stages = row.stages;
  if (stages === undefined || stages.length === 0) return null;
  return stages[stages.length - 1]!.stage;
}

export function scoreEval(judged: readonly JudgedQuestion[]): EvalResult {
  const outcomes: JudgedOutcome[] = judged.map((row) => {
    const bucket = classifyJudgement(row.question.expected, row.observed, {
      targetTopic: row.question.targetTopic,
      answerTopics: row.answerTopics ?? [],
    });
    const target = row.question.targetTopic;
    const answered = row.answerTopics ?? [];
    const offTopic =
      bucket === "false_answer" && target !== null && answered.length > 0 && !answered.includes(target)
        ? { target, answered }
        : undefined;
    return {
      ...row,
      expected: row.question.expected,
      bucket,
      ...(offTopic === undefined ? {} : { offTopic }),
    };
  });

  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<Bucket, number>;
  for (const outcome of outcomes) counts[outcome.bucket] += 1;

  const total = outcomes.length;
  const answerExpected = outcomes.filter((row) => row.expected === "answer").length;
  const escalationExpected = total - answerExpected;

  // A rate over an empty denominator is not zero — it is undefined. Returning
  // 1 for "every escalation-expected row escalated" when there are no such rows
  // is the only choice that cannot manufacture a breach out of nothing.
  const divide = (numerator: number, denominator: number, whenEmpty: number): number =>
    denominator === 0 ? whenEmpty : numerator / denominator;

  const scores: EvalScores = {
    falseAnswer: divide(counts.false_answer, total, 0),
    correctOrEscalation: divide(counts.correct_answer + counts.correct_escalation, total, 0),
    correctEscalation: divide(counts.correct_escalation, escalationExpected, 1),
    needlessEscalation: divide(counts.needless_escalation, answerExpected, 0),
  };

  const checkable = outcomes.filter((row) => row.expected === "answer");
  const retrievalMisses: RetrievalDiagnostic["misses"] = [];
  const notRunByStage: Record<string, number> = {};
  let matched = 0;
  let retrievalRun = 0;
  let checked = 0;
  for (const row of checkable) {
    const target = row.question.targetTopic;
    if (target === null) continue; // the validator forbids it; be forgiving anyway
    checked += 1;
    if (!retrievalRan(row)) {
      // A run that stopped before retrieval is attributed to the stage that
      // stopped it, and is never a recall miss: there was nothing to miss.
      const stage = endedAt(row) ?? "unknown";
      notRunByStage[stage] = (notRunByStage[stage] ?? 0) + 1;
      continue;
    }
    retrievalRun += 1;
    const retrieved = candidateTopics(row);
    if (retrieved.includes(target)) matched += 1;
    else
      retrievalMisses.push({
        question: row.question.question,
        language: row.question.language,
        targetTopic: target,
        retrieved,
      });
  }
  const retrieval: RetrievalDiagnostic = {
    checked,
    retrievalRun,
    matched,
    // Recall over rows where retrieval ran. When nothing ran the value is
    // undefined, not 100%: zero is the only reading that cannot masquerade as
    // a pass, and `notRunByStage` says why instead of leaving a bare number.
    rate: retrievalRun > 0 ? matched / retrievalRun : checked === 0 ? 1 : 0,
    notRunByStage,
    misses: retrievalMisses,
  };

  return {
    total,
    answerExpected,
    escalationExpected,
    counts,
    scores,
    outcomes,
    misses: outcomes.filter(
      (row) => row.bucket !== "correct_answer" && row.bucket !== "correct_escalation",
    ),
    retrieval,
  };
}

/* ---------- the gate ---------- */

export type GateMetric = keyof EvalScores | "outage" | "question_count";

export interface GateBreach {
  metric: GateMetric;
  value: number;
  limit: number;
  relation: "max" | "min" | "equal";
  detail: string;
}

export interface GateVerdict {
  pass: boolean;
  breaches: GateBreach[];
  /**
   * False when the golden set is smaller than `MIN_QUESTIONS_FOR_GATE`: the
   * verdict is still computed, but it cannot be called a G2 measurement.
   */
  armed: boolean;
  note: string;
}

/** Floating point: 4/200 is not exactly 0.02 in binary. */
const EPSILON = 1e-9;

/**
 * The absolute gate (plan Appendix D). Applied verbatim — no rounding, no
 * "close enough": 2.01% is a breach of a 2% cap.
 */
export function evaluateGate(
  result: EvalResult,
  thresholds: Thresholds = THRESHOLDS,
): GateVerdict {
  const breaches: GateBreach[] = [];

  if (result.counts.outage > 0) {
    breaches.push({
      metric: "outage",
      value: result.counts.outage,
      limit: 0,
      relation: "max",
      detail:
        "a provider outage is not a guardrail outcome — the run measured nothing for those questions",
    });
  }
  if (result.scores.falseAnswer > thresholds.falseAnswerMax + EPSILON) {
    breaches.push({
      metric: "falseAnswer",
      value: result.scores.falseAnswer,
      limit: thresholds.falseAnswerMax,
      relation: "max",
      detail: `${result.counts.false_answer} answered when a human was required`,
    });
  }
  if (result.scores.correctOrEscalation < thresholds.correctOrEscalationMin - EPSILON) {
    breaches.push({
      metric: "correctOrEscalation",
      value: result.scores.correctOrEscalation,
      limit: thresholds.correctOrEscalationMin,
      relation: "min",
      detail: `${result.counts.correct_answer + result.counts.correct_escalation}/${result.total} correct or correctly escalated`,
    });
  }
  if (
    result.escalationExpected > 0 &&
    result.scores.correctEscalation < thresholds.correctEscalationMin - EPSILON
  ) {
    breaches.push({
      metric: "correctEscalation",
      value: result.scores.correctEscalation,
      limit: thresholds.correctEscalationMin,
      relation: "min",
      detail: `${result.counts.correct_escalation}/${result.escalationExpected} escalation-expected rows escalated`,
    });
  }
  if (
    result.answerExpected > 0 &&
    result.scores.needlessEscalation > thresholds.needlessEscalationMax + EPSILON
  ) {
    breaches.push({
      metric: "needlessEscalation",
      value: result.scores.needlessEscalation,
      limit: thresholds.needlessEscalationMax,
      relation: "max",
      detail: `${result.counts.needless_escalation}/${result.answerExpected} answerable questions were refused`,
    });
  }

  const armed = result.total >= MIN_QUESTIONS_FOR_GATE;
  return {
    pass: breaches.length === 0,
    breaches,
    armed,
    note: armed
      ? `${result.total} questions: the 2% cap is expressible (one question = ${((1 / result.total) * 100).toFixed(2)}%).`
      : `${result.total} questions is below the ${MIN_QUESTIONS_FOR_GATE} the 2% cap needs; one question is worth ${((1 / result.total) * 100).toFixed(2)}% of the total.`,
  };
}

/* ---------- regression against a recorded baseline ---------- */

export interface EvalBaseline {
  goldenFile: string;
  total: number;
  counts: Record<Bucket, number>;
  scores: EvalScores;
}

export function baselineFrom(result: EvalResult, goldenFile: string): EvalBaseline {
  return { goldenFile, total: result.total, counts: result.counts, scores: result.scores };
}

/**
 * The CI gate: no score may be worse than the recorded baseline.
 *
 * This is what makes a *sub-2%* corpus useful. The absolute gate cannot be
 * armed until the golden set covers the articles a property actually has; the
 * regression gate can be armed immediately, because "did this change make
 * things worse" is answerable from any deterministic set. A changed question
 * count fails too: silently evaluating fewer questions would look like an
 * improvement.
 */
export function compareToBaseline(
  result: EvalResult,
  baseline: EvalBaseline,
): GateBreach[] {
  const breaches: GateBreach[] = [];

  if (result.total !== baseline.total) {
    breaches.push({
      metric: "question_count",
      value: result.total,
      limit: baseline.total,
      relation: "equal",
      detail: `the baseline was recorded on ${baseline.total} questions; re-record it deliberately with --update-baseline`,
    });
  }
  if (result.scores.falseAnswer > baseline.scores.falseAnswer + EPSILON) {
    breaches.push({
      metric: "falseAnswer",
      value: result.scores.falseAnswer,
      limit: baseline.scores.falseAnswer,
      relation: "max",
      detail: "more false answers than the baseline",
    });
  }
  if (result.scores.correctOrEscalation < baseline.scores.correctOrEscalation - EPSILON) {
    breaches.push({
      metric: "correctOrEscalation",
      value: result.scores.correctOrEscalation,
      limit: baseline.scores.correctOrEscalation,
      relation: "min",
      detail: "fewer correct-or-escalated answers than the baseline",
    });
  }
  if (result.scores.correctEscalation < baseline.scores.correctEscalation - EPSILON) {
    breaches.push({
      metric: "correctEscalation",
      value: result.scores.correctEscalation,
      limit: baseline.scores.correctEscalation,
      relation: "min",
      detail: "fewer of the escalation-expected rows escalated than the baseline",
    });
  }
  if (result.scores.needlessEscalation > baseline.scores.needlessEscalation + EPSILON) {
    breaches.push({
      metric: "needlessEscalation",
      value: result.scores.needlessEscalation,
      limit: baseline.scores.needlessEscalation,
      relation: "max",
      detail: "more answerable questions refused than the baseline",
    });
  }
  return breaches;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
