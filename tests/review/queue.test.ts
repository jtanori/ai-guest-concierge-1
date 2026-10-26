/**
 * S09-04 — the parts of the review queue that are pure, and therefore cheap to
 * pin down without a database.
 *
 * `aiRunIdFor` is exhaustive over `AnswerOutcome` on purpose: a new kind that
 * forgets to declare itself must be a compile error rather than an answer that
 * silently never reaches the review queue. The runtime half of that claim is here
 * (the two kinds that must queue nothing); the compile-time half is the `switch`
 * having no `default`.
 */
import { describe, expect, it } from "vitest";
import { aiRunIdFor, type AnswerOutcome } from "../../src/ai/answer.ts";
import { REVIEW_MAX_ATTEMPTS, reviewBackoffMs } from "../../src/review/queue.ts";

const RUN = "11111111-1111-5111-a111-111111111111";

describe("aiRunIdFor (S09-04)", () => {
  it("names the run for every outcome that has one", () => {
    const answer = { kind: "answer", aiRunId: RUN } as unknown as AnswerOutcome;
    const unavailable = { kind: "unavailable", aiRunId: RUN } as unknown as AnswerOutcome;
    expect(aiRunIdFor(answer)).toBe(RUN);
    expect(aiRunIdFor(unavailable)).toBe(RUN);
  });

  it("passes through an escalation's null run", () => {
    // A guard that blocked before the model was called has no run and nothing to
    // review; an escalation that happened after one does.
    const blocked = { kind: "escalate", aiRunId: null } as unknown as AnswerOutcome;
    const ran = { kind: "escalate", aiRunId: RUN } as unknown as AnswerOutcome;
    expect(aiRunIdFor(blocked)).toBeNull();
    expect(aiRunIdFor(ran)).toBe(RUN);
  });

  it("queues nothing for a fact or a no-answer", () => {
    // A fact called no model: it is a verified value from property_facts, not an
    // answer to review. A no-answer on the empty-retrieval path records no run at
    // all, and the knowledge-gap queue (S09-02) already owns that miss.
    expect(aiRunIdFor({ kind: "fact" } as unknown as AnswerOutcome)).toBeNull();
    expect(aiRunIdFor({ kind: "no_answer" } as unknown as AnswerOutcome)).toBeNull();
  });
});

describe("review backoff (S09-04)", () => {
  it("doubles, and stops at a minute", () => {
    expect(reviewBackoffMs(1)).toBe(1_000);
    expect(reviewBackoffMs(2)).toBe(2_000);
    expect(reviewBackoffMs(3)).toBe(4_000);
    expect(reviewBackoffMs(4)).toBe(8_000);
    expect(reviewBackoffMs(5)).toBe(16_000);
    expect(reviewBackoffMs(20)).toBe(60_000);
  });

  it("treats a zero or negative attempt count as the first step", () => {
    // A row that has never been attempted must not be retried immediately, and
    // must not produce a negative interval.
    expect(reviewBackoffMs(0)).toBe(1_000);
    expect(reviewBackoffMs(-1)).toBe(1_000);
  });

  it("gives up before the backoff reaches its cap", () => {
    expect(REVIEW_MAX_ATTEMPTS).toBe(5);
    expect(reviewBackoffMs(REVIEW_MAX_ATTEMPTS)).toBeLessThan(60_000);
  });
});
