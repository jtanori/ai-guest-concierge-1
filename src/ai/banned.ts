/**
 * S05-02 / AC-2 — content that must never be generated, whatever the articles
 * say.
 *
 * Two different kinds of rule live here, and conflating them would be a mistake:
 *
 *  1. **Invented commitments.** A model must not tell a guest a price, that a
 *     room is available, that a booking is "confirmed", or that someone is "on
 *     the way". These are not facts an article can authorise: prices change,
 *     availability is real-time, and a confirmation the hotel has not made is a
 *     contractual statement. A match escalates — it is never edited out and
 *     sent, because the rest of the sentence was built on the same invention.
 *  2. **PII.** A card number in an answer is a breach regardless of intent.
 *
 * The patterns are compiled once, and they cover Spanish as well as English —
 * the property's guests write Spanish, and a rule that only fires in English
 * would be theatre. Matching is case-insensitive and accent-tolerant at the
 * word level (`confirmad[oa]`, `reservad[oa]`), because accents are the first
 * thing a model drops.
 *
 * Scope note: these are *generation* guardrails, not a content policy for
 * articles. An article may state a price; an ANSWER may not, because the model
 * is re-composing text under uncertainty.
 */
import { looksLikeCardNumber } from "../security/pii.ts";

export interface BannedRule {
  id: string;
  /** Human-readable reason, used in the ai_runs row and the alert. */
  description: string;
  pattern: RegExp;
}

export const BANNED_RULES: readonly BannedRule[] = [
  {
    id: "currency_amount",
    description: "a price or amount",
    // 1,200 / 1200.50 / $45 followed by a currency word or symbol.
    pattern:
      /(?:[$€]\s?\d[\d.,]*)|(?:\b\d[\d.,]*\s?(?:mxn|usd|eur|pesos?|d[oó]lares?|dollars?)\b)/i,
  },
  {
    id: "availability_claim",
    description: "a claim about room availability",
    pattern:
      /\b(?:we have (?:a |an )?(?:room|suite|table)s? (?:available|open)|(?:room|suite|table)s? (?:are )?available|rooms? available (?:tonight|today)|tenemos (?:una )?(?:habitaci[oó]n|mesa) disponible|hay (?:habitaciones|mesas) disponibles?)\b/i,
  },
  {
    id: "confirmed_booking",
    description: "a booking stated as confirmed",
    pattern:
      /\b(?:your (?:booking|reservation) is (?:now )?confirmed|you(?:'re| are) (?:all )?set for|confirmad[oa]s?|reservaci[oó]n confirmada|queda (?:confirmad[oa]|reservad[oa]))\b/i,
  },
  {
    id: "en_route",
    description: "someone stated as on the way",
    pattern:
      /\b(?:on (?:my|our|their|its|the) way|en camino|va en camino|ya (?:va|sali[oó]))\b/i,
  },
  {
    id: "booked_for_you",
    description: "a table/seat stated as booked",
    pattern: /\b(?:i(?:'ve| have)? booked|booked (?:it|that|you)|te (?:la |lo )?reserv[eé]|ya (?:est[aá] )?reservad[oa])\b/i,
  },
];

export interface BannedMatch {
  ruleId: string;
  description: string;
  /** The offending text, truncated: enough to debug, not enough to leak. */
  excerpt: string;
}

const EXCERPT_LIMIT = 60;

function excerpt(text: string, index: number): string {
  const start = Math.max(0, index - 20);
  const slice = text.slice(start, start + EXCERPT_LIMIT).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${slice}` : slice;
}

/**
 * Returns every rule the text violates. Empty means "clean".
 *
 * The full list matters: a sentence that promises a price AND a confirmation is
 * one failure with two causes, and the operator should see both.
 */
export function findBannedContent(text: string): BannedMatch[] {
  const matches: BannedMatch[] = [];
  for (const rule of BANNED_RULES) {
    // Reset lastIndex: these regexes are shared across calls (`/g` is not used,
    // but a future edit must not make this stateful).
    rule.pattern.lastIndex = 0;
    const found = rule.pattern.exec(text);
    if (found !== null) {
      matches.push({
        ruleId: rule.id,
        description: rule.description,
        excerpt: excerpt(text, found.index),
      });
    }
  }
  if (looksLikeCardNumber(text)) {
    matches.push({
      ruleId: "card_number",
      description: "a payment card number",
      // Never echo the digits, not even truncated.
      excerpt: "[redacted]",
    });
  }
  return matches;
}
