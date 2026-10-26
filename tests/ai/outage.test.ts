/**
 * S07-05 — the outage path's cheap half: the chaos hook and the vocabulary.
 *
 * The pipeline behaviour (honest reply + request + `message_failed`, all in one
 * transaction) needs a database and lives in `tests/db/outage.db.test.ts`. What
 * is tested here is the part that decides WHETHER that path can be reached on
 * purpose, and the closed vocabulary it writes into.
 */
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/config/env.ts";
import { AI_REASON_CODES, AI_RUN_REASON_CODES } from "../../src/ai/contract.ts";
import { chaosModeFromEnv, loadChaosMode, withChaos } from "../../src/ai/chaos.ts";
import {
  AiUnavailableError,
  withResilience,
  type AiRequest,
  type AiResult,
  type ResilientAi,
} from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";

const REQUEST: AiRequest = {
  system: "s",
  prompt: "p",
  schema: {},
  temperature: 0,
  timeoutMs: 1_000,
};

function workingAi(modelId = "stub-primary-2026-01-01"): ResilientAi {
  return withResilience(createFixedProvider({ ok: true }, modelId), createFixedProvider({}, "stub-fallback-2026-01-01"), {
    retries: 0,
    sleep: async () => {},
    now: () => 0,
  });
}

describe("loadChaosMode", () => {
  it("defaults to none when unset or empty", () => {
    expect(loadChaosMode({}, "prod")).toBe("none");
    expect(loadChaosMode({ AI_FAIL_MODE: "  " }, "staging")).toBe("none");
  });

  it("accepts the three modes on a non-production host", () => {
    expect(loadChaosMode({ AI_FAIL_MODE: "once" }, "staging")).toBe("once");
    expect(loadChaosMode({ AI_FAIL_MODE: "always" }, "local")).toBe("always");
    expect(loadChaosMode({ AI_FAIL_MODE: "ALWAYS" }, "local")).toBe("always");
  });

  it("refuses anything but none in production, and says why", () => {
    expect(loadChaosMode({ AI_FAIL_MODE: "none" }, "prod")).toBe("none");
    for (const mode of ["once", "always"]) {
      expect(() => loadChaosMode({ AI_FAIL_MODE: mode }, "prod")).toThrow(ConfigError);
      expect(() => loadChaosMode({ AI_FAIL_MODE: mode }, "prod")).toThrow(/APP_ENV=prod/);
    }
  });

  it("refuses a value it does not understand instead of ignoring it", () => {
    expect(() => loadChaosMode({ AI_FAIL_MODE: "sometimes" }, "staging")).toThrow(/AI_FAIL_MODE/);
  });

  it("reads APP_ENV, defaulting to local", () => {
    expect(chaosModeFromEnv({ AI_FAIL_MODE: "once" } as NodeJS.ProcessEnv)).toBe("once");
  });

  it("throws under APP_ENV=prod rather than quietly downgrading", () => {
    expect(() =>
      chaosModeFromEnv({ APP_ENV: "prod", AI_FAIL_MODE: "always" } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });
});

describe("withChaos", () => {
  it("is a pass-through when the mode is none", async () => {
    const ai = workingAi();
    const wrapped = withChaos(ai, "none");
    const result = await wrapped.generate(REQUEST);
    expect(result.modelId).toBe("stub-primary-2026-01-01");
  });

  it("always: every call fails with the real outage error, contacting no provider", async () => {
    const ai = workingAi();
    const spy = vi.spyOn(ai, "generate");
    const wrapped = withChaos(ai, "always");
    for (let i = 0; i < 3; i += 1) {
      await expect(wrapped.generate(REQUEST)).rejects.toBeInstanceOf(AiUnavailableError);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("once: the first call fails and the next ones succeed", async () => {
    const wrapped = withChaos(workingAi(), "once");
    await expect(wrapped.generate(REQUEST)).rejects.toBeInstanceOf(AiUnavailableError);
    const result: AiResult = await wrapped.generate(REQUEST);
    expect(result.modelId).toBe("stub-primary-2026-01-01");
    await expect(wrapped.generate(REQUEST)).resolves.toBeTruthy();
  });

  it("does not disturb the wrapped circuit state", () => {
    // A deliberate failure is not a provider outage: tripping the real circuit
    // would make a chaos run poison the next 60 seconds of genuine traffic.
    const ai = workingAi();
    const wrapped = withChaos(ai, "always");
    expect(wrapped.isCircuitOpen()).toBe(ai.isCircuitOpen());
  });
});

describe("the run vocabulary", () => {
  it("keeps provider_unavailable out of the model's own reason codes", () => {
    // The model's enum is what the JSON schema advertises. A model that can say
    // "provider_unavailable" can pretend to be an outage.
    expect(AI_REASON_CODES).not.toContain("provider_unavailable");
    expect(AI_RUN_REASON_CODES).toContain("provider_unavailable");
  });

  it("is the model's vocabulary plus exactly the pipeline's own codes", () => {
    const extra = AI_RUN_REASON_CODES.filter((code) => !(AI_REASON_CODES as readonly string[]).includes(code));
    expect(extra).toEqual(["provider_unavailable"]);
  });

  it("has no duplicates, so a query by code cannot double-count", () => {
    expect(new Set(AI_RUN_REASON_CODES).size).toBe(AI_RUN_REASON_CODES.length);
  });
});

describe("AiUnavailableError", () => {
  it("carries the attempted models so the run row can name them without lying", () => {
    const error = new AiUnavailableError(4, new Error("boom"), ["a-model", "b-model"]);
    expect(error.attempts).toBe(4);
    expect(error.modelIds).toEqual(["a-model", "b-model"]);
    // Never the provider's message: it can carry the key.
    expect(error.message).not.toContain("boom");
  });

  it("defaults to an empty list rather than guessing a model", () => {
    expect(new AiUnavailableError(2).modelIds).toEqual([]);
  });
});
