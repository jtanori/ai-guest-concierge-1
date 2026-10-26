/**
 * S05-01 / D12 — the transport rules, tested against fake providers.
 *
 * No network, no keys, no sleeping: the clock, the jitter and the sleep are
 * injected, so "retries twice with jitter" and "circuit-break for 60 seconds"
 * are asserted as behaviour rather than described in a comment. The one thing
 * these tests cannot prove is that a vendor adapter actually aborts its socket
 * on timeout; `withTimeout` only guarantees the CALLER stops waiting.
 */
import { describe, expect, it } from "vitest";
import {
  AiProviderError,
  AiUnavailableError,
  withResilience,
  type AiProvider,
  type AiRequest,
} from "../../src/ai/provider.ts";

const request: AiRequest = {
  system: "system",
  prompt: "prompt",
  schema: { type: "object" },
  temperature: 0,
  timeoutMs: 8_000,
};

interface Fake extends AiProvider {
  calls: number;
}

/** A provider that replays `responses` in order, then repeats the last one. */
function fake(modelId: string, responses: Array<unknown | Error>): Fake {
  const provider: Fake = {
    modelId,
    calls: 0,
    async generate(): Promise<unknown> {
      const index = Math.min(provider.calls, responses.length - 1);
      provider.calls += 1;
      const response = responses[index];
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return provider;
}

function harness(responses: {
  primary: Array<unknown | Error>;
  fallback: Array<unknown | Error>;
}) {
  const primary = fake("primary-2026-01-01", responses.primary);
  const fallback = fake("fallback-2026-01-01", responses.fallback);
  let clock = 0;
  const sleeps: number[] = [];
  const ai = withResilience(primary, fallback, {
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    baseRetryDelayMs: 100,
    circuitOpenMs: 60_000,
  });
  return { primary, fallback, ai, sleeps, advance: (ms: number) => (clock += ms) };
}

describe("AI transport resilience", () => {
  it("returns the primary result on the first success", async () => {
    const { ai, primary, fallback } = harness({ primary: [{ ok: true }], fallback: [{ ok: "fb" }] });
    const result = await ai.generate(request);
    expect(result).toMatchObject({ modelId: "primary-2026-01-01", usedFallback: false, attempts: 1 });
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it("retries a 429 with growing, jittered delays and then succeeds", async () => {
    const { ai, primary, sleeps } = harness({
      primary: [new AiProviderError("rate limited", { status: 429 }), { ok: true }],
      fallback: [{ ok: "fb" }],
    });
    const result = await ai.generate(request);
    expect(result.usedFallback).toBe(false);
    expect(primary.calls).toBe(2);
    // 100ms * 2^0 * (0.5 + 0.5/2 .. ) with random()=0.5 -> 75ms, then 150ms.
    expect(sleeps).toEqual([75]);
  });

  it("retries twice and no more, then falls back and opens the circuit", async () => {
    const { ai, primary, fallback, sleeps } = harness({
      primary: [
        new AiProviderError("boom", { status: 503 }),
        new AiProviderError("boom", { status: 503 }),
        new AiProviderError("boom", { status: 503 }),
      ],
      fallback: [{ ok: "fb" }],
    });
    const result = await ai.generate(request);
    expect(primary.calls).toBe(3); // 1 attempt + 2 retries
    expect(sleeps).toHaveLength(2);
    expect(result).toMatchObject({ modelId: "fallback-2026-01-01", usedFallback: true });
    expect(fallback.calls).toBe(1);
    expect(ai.isCircuitOpen()).toBe(true);
  });

  it("does not retry a 400: our request is wrong and will stay wrong", async () => {
    const { ai, primary, sleeps } = harness({
      primary: [new AiProviderError("bad request", { status: 400 })],
      fallback: [{ ok: "fb" }],
    });
    const result = await ai.generate(request);
    expect(primary.calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(result.usedFallback).toBe(true);
  });

  it("skips the primary entirely while the circuit is open, then tries it again", async () => {
    const { ai, primary, advance } = harness({
      primary: [new AiProviderError("down", { status: 500 })],
      fallback: [{ ok: "fb" }],
    });
    await ai.generate(request);
    const callsAfterFirst = primary.calls;
    expect(ai.isCircuitOpen()).toBe(true);

    // Inside the 60s window the primary is not even called.
    await ai.generate(request);
    expect(primary.calls).toBe(callsAfterFirst);

    // After it, the primary gets another chance.
    advance(60_001);
    expect(ai.isCircuitOpen()).toBe(false);
    await ai.generate(request);
    expect(primary.calls).toBeGreaterThan(callsAfterFirst);
  });

  it("throws AiUnavailableError when both providers fail, and never returns raw", async () => {
    const { ai, primary, fallback } = harness({
      primary: [new AiProviderError("down", { status: 500 })],
      fallback: [new AiProviderError("also down", { status: 500 })],
    });
    await expect(ai.generate(request)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(primary.calls).toBe(3);
    expect(fallback.calls).toBe(3);
  });

  it("times out a provider that never settles instead of waiting on it", async () => {
    const hang: AiProvider = {
      modelId: "hang-2026-01-01",
      generate: () => new Promise<unknown>(() => {}),
    };
    const fallback = fake("fallback-2026-01-01", [{ ok: "fb" }]);
    const ai = withResilience(hang, fallback, {
      retries: 0,
      now: () => 0,
      sleep: async () => {},
    });
    const result = await ai.generate({ ...request, timeoutMs: 20 });
    expect(result).toMatchObject({ modelId: "fallback-2026-01-01", usedFallback: true });
  });

  it("refuses a 'fallback' that is the same pinned model", () => {
    expect(() =>
      withResilience(fake("same-2026-01-01", [{}]), fake("same-2026-01-01", [{}]), {
        sleep: async () => {},
      }),
    ).toThrow(/must differ/);
  });
});
