/**
 * S05-01 — a provider that never calls a network.
 *
 * CI must exercise the whole answer pipeline without a key, without cost and
 * without a vendor deciding when a build goes red. The stub is deliberately
 * dumb: it replays whatever script the test handed it, so the interesting
 * behaviour (contract validation, retry policy, escalation) stays under the
 * test's control rather than a model's.
 *
 * It is NOT a fake model behind a flag in production code: `createGeminiProvider`
 * is the only real adapter, and nothing chooses a stub based on `APP_ENV`.
 */
import type { AiProvider, AiRequest } from "./provider.ts";

export interface StubProvider extends AiProvider {
  readonly requests: AiRequest[];
}

/** Replays `responses` in order, repeating the last one. */
export function createScriptedProvider(
  responses: ReadonlyArray<unknown | Error>,
  modelId = "stub-model-2026-01-01",
): StubProvider {
  const requests: AiRequest[] = [];
  if (responses.length === 0) throw new RangeError("scripted provider needs at least one response");
  return {
    modelId,
    requests,
    async generate(request: AiRequest): Promise<unknown> {
      const index = Math.min(requests.length, responses.length - 1);
      requests.push(request);
      const response = responses[index];
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

/** Always answers with one fixed value: for tests that only care that a call
 *  happened, and for a smoke run with no key. */
export function createFixedProvider(output: unknown, modelId = "stub-model-2026-01-01"): StubProvider {
  return createScriptedProvider([output], modelId);
}
