/**
 * S06-03 — the G2 numbers, in one file.
 *
 * These four constants are the sprint gate (plan Appendix D). They live here
 * rather than inside `scripts/eval.ts` so that the script, the CI workflow, the
 * unit tests and the runbook all read the same values: a threshold that is
 * quoted in prose and enforced in code is a threshold that will disagree with
 * itself within a sprint.
 *
 * The direction is part of the definition, and getting it backwards is the
 * failure mode that matters — a "gate" that fails when the false-answer rate is
 * *too low* is worse than no gate at all.
 */

/** ≤2% of the golden set may be answered when it should have escalated. */
export const FALSE_ANSWER_MAX = 0.02;

/** ≥95% of questions must be answered correctly or escalated to a human. */
export const CORRECT_OR_ESCALATION_MIN = 0.95;

/** ≥90% of the questions that *should* escalate must actually escalate. */
export const CORRECT_ESCALATION_MIN = 0.9;

/** ≤20% of the questions that *can* be answered may be needlessly escalated. */
export const NEEDLESS_ESCALATION_MAX = 0.2;

/**
 * 2% is one question in fifty. Below fifty questions the false-answer clause
 * cannot express its own limit: a set of 20 has a granularity of 5%, so either
 * the gate is silently stricter than it says (zero tolerance) or it is
 * measuring nothing. Recorded rather than silently assumed — the runbook and
 * the CLI both print which of the two situations the current set is in.
 */
export const MIN_QUESTIONS_FOR_GATE = 50;

export const THRESHOLDS = {
  falseAnswerMax: FALSE_ANSWER_MAX,
  correctOrEscalationMin: CORRECT_OR_ESCALATION_MIN,
  correctEscalationMin: CORRECT_ESCALATION_MIN,
  needlessEscalationMax: NEEDLESS_ESCALATION_MAX,
} as const;

export type Thresholds = typeof THRESHOLDS;
