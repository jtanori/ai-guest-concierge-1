/**
 * S04-03 — where an answer comes from, decided before anything is generated.
 *
 * Hours are data, not prose (S03-03). When the caller can name the fact
 * (`topic.hours` + `closing_time`, the structured half of a guest's question —
 * a slot-filling classifier produces it, not a model), a verified fact wins
 * outright: `lookupFact` is an exact-key lookup of human-verified rows and
 * cannot hallucinate. Only when there is no verified fact does the question go
 * to retrieval, which returns hotel prose for S05 to phrase.
 *
 * The ordering is the point. Retrieval first and fact-as-fallback would mean a
 * stale article body can out-vote the verified value an operator just signed
 * off — the exact failure S03-03 exists to prevent.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import { lookupFact, type FactLookupInput, type FactLookupResult } from "./facts.ts";
import { retrieveCurrentVersions, type RetrievalHit, type RetrievalInput } from "./retrieval.ts";

export interface StructuredQuestion {
  topicKey: string;
  factKey: string;
  language: string;
  /** Only facts effective on or before this date count; defaults to today. */
  on?: string;
}

export type AnswerSource =
  | { kind: "fact"; fact: FactLookupResult }
  | { kind: "articles"; hits: RetrievalHit[] };

export interface AnswerSourceInput extends RetrievalInput {
  structured?: StructuredQuestion;
}

export async function resolveAnswerSource(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: AnswerSourceInput,
): Promise<AnswerSource> {
  assertTenantShape(context);

  if (input.structured !== undefined) {
    const lookup: FactLookupInput = {
      topicKey: input.structured.topicKey,
      factKey: input.structured.factKey,
      language: input.structured.language,
      ...(input.structured.on === undefined ? {} : { on: input.structured.on }),
    };
    const fact = await lookupFact(client, context, lookup);
    if (fact !== null) return { kind: "fact", fact };
  }

  return { kind: "articles", hits: await retrieveCurrentVersions(client, context, input) };
}
