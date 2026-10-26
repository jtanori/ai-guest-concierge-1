/**
 * S06-02 — the state machine as a pure unit.
 *
 * The trigger is the authority (tests/db/conversation-state.db.test.ts), but a
 * matrix that only exists inside a plpgsql function is a matrix nobody reviews.
 * These cases hold the TypeScript copy to its own rules, including the rules
 * about the rules: every state has an entry, no entry names a state that does
 * not exist, and a no-op is not a transition.
 */
import { describe, expect, it } from "vitest";
import {
  AI_STATES,
  IllegalTransitionError,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isAiState,
  modelMaySpeak,
  type AiState,
} from "../../src/conversation/state.ts";

const LEGAL: Array<[AiState, AiState]> = [
  ["idle", "awaiting_ai"],
  ["idle", "awaiting_staff"],
  ["awaiting_ai", "idle"],
  ["awaiting_ai", "awaiting_staff"],
  ["awaiting_ai", "resolved"],
  ["awaiting_staff", "resolved"],
  ["awaiting_staff", "awaiting_ai"],
  ["resolved", "awaiting_ai"],
  // S07-02: one tap from a concluded thread still reaches a human.
  ["resolved", "awaiting_staff"],
];

const ILLEGAL: Array<[AiState, AiState]> = [
  ["idle", "resolved"],
  ["awaiting_staff", "idle"],
  ["resolved", "idle"],
];

describe("conversation state matrix (S06-02)", () => {
  it("declares an entry for every state and names only real states", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...AI_STATES].sort());
    for (const targets of Object.values(TRANSITIONS)) {
      for (const target of targets) expect(isAiState(target)).toBe(true);
    }
  });

  it("covers exactly the nine legal edges", () => {
    const edges = AI_STATES.flatMap((from) =>
      TRANSITIONS[from].map((to) => `${from}->${to}`),
    ).sort();
    expect(edges).toEqual(LEGAL.map(([from, to]) => `${from}->${to}`).sort());
  });

  it("accepts every legal transition", () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to)).toBe(true);
      expect(() => {
        assertTransition(from, to);
      }).not.toThrow();
    }
  });

  it("rejects every illegal one, and says which are allowed", () => {
    for (const [from, to] of ILLEGAL) {
      expect(canTransition(from, to)).toBe(false);
      expect(() => {
        assertTransition(from, to);
      }).toThrow(IllegalTransitionError);
      try {
        assertTransition(from, to);
      } catch (error) {
        expect((error as IllegalTransitionError).message).toContain(`${from} -> ${to}`);
      }
    }
  });

  it("treats same-state as a no-op rather than a transition", () => {
    for (const state of AI_STATES) {
      expect(canTransition(state, state)).toBe(true);
      expect(TRANSITIONS[state]).not.toContain(state);
    }
  });

  it("rejects states that are not in the enum, including SQL-ish aliases", () => {
    expect(isAiState("IDLE")).toBe(false);
    expect(isAiState("closed")).toBe(false); // `status`, not `ai_state`
    expect(isAiState(undefined)).toBe(false);
    expect(() => {
      assertTransition("idle", "closed" as AiState);
    }).toThrow(IllegalTransitionError);
    expect(() => {
      assertTransition("nope" as AiState, "idle");
    }).toThrow(IllegalTransitionError);
  });

  it("knows exactly when the model may speak", () => {
    expect(AI_STATES.filter(modelMaySpeak)).toEqual(["idle", "awaiting_ai", "resolved"]);
    // The one that matters: a staff takeover silences the model.
    expect(modelMaySpeak("awaiting_staff")).toBe(false);
  });
});
