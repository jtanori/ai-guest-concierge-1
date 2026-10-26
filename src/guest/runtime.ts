/**
 * S06-01 — the production wiring for the guest surface, in one place.
 *
 * `src/server.ts` owns the HTTP listener; this owns "what a guest request needs
 * to be answerable". Keeping it separate is what lets the DB and HTTP tests
 * inject a scripted provider and a fixed clock without a second code path: the
 * shape a test builds by hand is the shape this function returns.
 *
 * Two deliberate omissions:
 *
 *  - **No stub provider in production.** An unconfigured LLM throws here and the
 *    route answers 503, exactly like every other degraded-host path in this
 *    server. Choosing a fake model based on `APP_ENV` is how a preview ends up
 *    silently publishing model text nobody generated.
 *  - **The embedding is optional.** Without `EMBEDDING_API_KEY` the pipeline
 *    runs on lexical + trigram retrieval (S04-03); with it, the vector branch
 *    joins in. A guest never waits on an embedding to get an answer.
 */
import {
  ConfigError,
  isEnvName,
  loadEmbeddingConfig,
  loadLlmConfig,
  type EnvName,
} from "../config/env.ts";
import { withResilience, type ResilientAi } from "../ai/provider.ts";
import { createGeminiProvider } from "../providers/gemini.ts";
import { createEmbeddingProvider, type EmbeddingProvider } from "../providers/embedding.ts";
import { loadGuestConfig, type GuestConfig } from "./cookie.ts";
import { botCheckConfigFromEnv, type BotCheckConfig } from "../security/botcheck.ts";
import { chaosModeFromEnv, withChaos, type ChaosMode } from "../ai/chaos.ts";

export interface GuestRuntime {
  cookieSecret: string;
  ai: ResilientAi;
  embed?: (text: string) => Promise<number[]>;
  /**
   * S07-04: the bot check. Always present in the resolved runtime — `disabled`
   * is a real config value in local, and a boot failure everywhere else, so
   * "there is no bot check configuration" is not a state a host can be in.
   */
  botCheck: BotCheckConfig;
  /**
   * S07-05: `none` unless `AI_FAIL_MODE` was set on a non-production host. Always
   * present so "is this host deliberately failing its AI?" is answerable, and so
   * `/healthz`-style output cannot go looking for an undefined.
   */
  aiFailMode: ChaosMode;
}

/**
 * The LLM pair (D12): two pinned models behind one resilient wrapper. Both are
 * required — a fallback that is disabled on the host that needs it is not a
 * fallback.
 */
export function buildAi(source: NodeJS.ProcessEnv): ResilientAi {
  const appEnv: EnvName = isEnvName(source["APP_ENV"] ?? "") ? (source["APP_ENV"] as EnvName) : "local";
  const llm = loadLlmConfig(source, appEnv);
  return withResilience(
    createGeminiProvider({
      apiKey: llm.apiKey,
      model: llm.primaryModel,
      baseUrl: llm.baseUrl,
      timeoutMs: llm.timeoutMs,
    }),
    createGeminiProvider({
      apiKey: llm.apiKey,
      model: llm.fallbackModel,
      baseUrl: llm.baseUrl,
      timeoutMs: llm.timeoutMs,
    }),
    // S07-06: the retry budget is configuration (LLM_RETRIES), defaulted to the
    // plan's two, so the transport policy is not re-invented per call site.
    { retries: llm.retries },
  );
}

/** Absent key ⇒ no vector branch. A present-but-broken key is a boot failure. */
export function buildEmbedder(source: NodeJS.ProcessEnv): ((text: string) => Promise<number[]>) | undefined {
  if (((source["EMBEDDING_API_KEY"] ?? "").trim()) === "") return undefined;
  const provider: EmbeddingProvider = createEmbeddingProvider(loadEmbeddingConfig(source));
  return async (text: string): Promise<number[]> => {
    const [vector] = await provider.embed([text]);
    if (vector === undefined) throw new ConfigError("embedding provider returned no vector");
    return vector;
  };
}

/** Everything a guest request needs except the database connection. */
export function guestRuntimeFromEnv(source: NodeJS.ProcessEnv): GuestRuntime & GuestConfig {
  const config = loadGuestConfig(source);
  const embed = buildEmbedder(source);
  // S07-05: resolved first, so a bad or production-illegal value fails at boot
  // rather than on a guest's turn.
  const aiFailMode = chaosModeFromEnv(source);
  return {
    ...config,
    ai: withChaos(buildAi(source), aiFailMode),
    aiFailMode,
    botCheck: botCheckConfigFromEnv(source),
    ...(embed === undefined ? {} : { embed }),
  };
}
