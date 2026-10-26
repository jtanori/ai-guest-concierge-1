/**
 * S05-02 / AC-1 — the last gate before an answer becomes sendable.
 *
 * `parseAiOutput` (S05-01) checks SHAPE: the JSON is well-formed and the
 * citation ids are drawn from what was retrieved. This checks MEANING, and the
 * distinction is the whole point:
 *
 *  - **Entailment.** A citation is only a citation if the quoted words are
 *    actually in the cited text. A model that cites a retrieved version and
 *    then quotes a sentence that exists nowhere is doing the most dangerous
 *    thing in the product: manufacturing a source. The check is normalised
 *    substring containment over the matched chunk and the version body —
 *    deliberately mechanical. It cannot prove semantic entailment (that is the
 *    audit sample, S12), but it does catch the fabrication pattern that matters,
 *    and it is a check no model can talk its way past.
 *  - **Banned content** (banned.ts): invented price, availability, "confirmed",
 *    "on the way", a card number.
 *  - **Confidence floor.** Optional and OFF by default (`minConfidence: 0`). A
 *    floor invented here would be a number with no evidence behind it; S06-03
 *    calibrates it against the golden set and S07-04 can pass a property's own
 *    value. That is why it is a parameter and not a constant.
 *
 * Every rejection names a `reason_code`. There is no "silently drop the answer"
 * path: a rejection is an escalation the operator can see, count and fix.
 */
import type { AiOutput, AiReasonCode } from "./contract.ts";
import { findBannedContent, type BannedMatch } from "./banned.ts";
import type { RetrievalHit } from "../knowledge/retrieval.ts";

export interface GuardOptions {
  /** 0 (default) disables the floor. See the header. */
  minConfidence?: number;
}

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode: AiReasonCode;
      /** Machine-readable cause, e.g. "quote_not_in_cited_version". */
      detail: string;
      violations: string[];
    };

const WHITESPACE = /\s+/g;
const ELLIPSIS = /…|\.\.\./g;

/**
 * Normalises text for quote containment: case, whitespace and accent folding
 * are not meaning, and a model that writes "cierra a las 20:00" against a body
 * saying "cierra a las 20:00." must not be rejected over a full stop.
 */
export function normaliseForQuoteMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(ELLIPSIS, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(WHITESPACE, " ")
    .trim();
}

export function verifyAnswer(
  output: AiOutput,
  retrieved: readonly RetrievalHit[],
  options: GuardOptions = {},
): GuardResult {
  // A non-answer is not "verified": it is not sendable at all. S05-01 escalates
  // it, and calling that a guardrail pass would be a lie in the logs.
  if (output.decision !== "answer") {
    return {
      ok: false,
      reasonCode: output.reasonCode ?? "policy_block",
      detail: "not_an_answer",
      violations: [`decision is ${output.decision}: nothing to send`],
    };
  }

  const violations: string[] = [];
  const byVersion = new Map(retrieved.map((hit) => [hit.articleVersionId, hit]));

  if (output.citations.length === 0) {
    violations.push("an answer with no citations");
  }

  for (const citation of output.citations) {
    const hit = byVersion.get(citation.articleVersionId);
    if (hit === undefined) {
      // parseAiOutput already refuses this; defence in depth costs one Set
      // lookup, and this function must be safe to call on any AiOutput.
      violations.push(`citation ${citation.articleVersionId} was not retrieved`);
      continue;
    }
    const quote = normaliseForQuoteMatch(citation.quote);
    if (quote === "") {
      violations.push(`citation ${citation.articleVersionId} has an empty quote`);
      continue;
    }
    const inChunk =
      hit.matchedChunk !== undefined &&
      normaliseForQuoteMatch(hit.matchedChunk.body).includes(quote);
    const inBody = normaliseForQuoteMatch(hit.body).includes(quote);
    if (!inChunk && !inBody) {
      violations.push(
        `quote "${citation.quote.slice(0, 60)}" does not appear in the cited version`,
      );
    }
  }

  const banned: BannedMatch[] = findBannedContent(output.answer ?? "");
  for (const match of banned) {
    violations.push(`banned content (${match.ruleId}): ${match.description}`);
  }

  const floor = options.minConfidence ?? 0;
  if (floor > 0 && output.confidence < floor) {
    violations.push(`confidence ${output.confidence} is below the floor ${floor}`);
  }

  if (violations.length === 0) return { ok: true };

  // Reason-code choice: banned content is a policy block; everything else is an
  // answer we could not stand behind, which is the same operational state as a
  // retrieval miss — a human gets it.
  const reasonCode: AiReasonCode = banned.length > 0 ? "policy_block" : "low_retrieval";
  const detail =
    banned.length > 0
      ? `banned_content:${banned.map((match) => match.ruleId).join(",")}`
      : violations.some((violation) => violation.includes("does not appear"))
        ? "quote_not_in_cited_version"
        : "citation_check_failed";

  return { ok: false, reasonCode, detail, violations };
}
