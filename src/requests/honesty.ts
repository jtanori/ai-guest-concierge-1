/**
 * S07-03 AC-2 — the check that the product never claims a request is fulfilled.
 *
 * The rule is a product rule, not a model rule: *the guest is told the truth
 * about what happened.* A bot that says "your request is confirmed" when a row
 * is sitting in `status='new'` has told the guest something false about their
 * stay, and no amount of correct article retrieval makes up for it.
 *
 * So the check is mechanical and lives in code next to the copy it constrains:
 * `findFulfilmentClaim` is applied by `tests/requests/honesty.test.ts` to
 * **every** catalogue string in **both** languages, not to a curated list of
 * "outbound templates". A curated list is the failure mode — the one string
 * someone adds at 6pm without adding it to the list is the one that ships.
 *
 * Deliberately separate from `src/ai/banned.ts`:
 *
 *  - `banned.ts` guards **model output** at generation time. It fires on a
 *    price, an availability claim or a card number, and its response is to
 *    escalate instead of sending.
 *  - this guards **our own copy** at build time. It fires on "confirmed",
 *    "booked", "on the way", "done", "listo", "completado" — the words a human
 *    writes when they *want* to be reassuring — and its response is a red test.
 *
 * Merging them would mean one list serving two jobs with two different failure
 * responses, which is how a list ends up tuned for neither.
 */

export interface FulfilmentRule {
  id: string;
  /** Operator-facing reason, used in the test's failure message. */
  description: string;
  pattern: RegExp;
}

export const FULFILMENT_RULES: readonly FulfilmentRule[] = [
  {
    id: "confirmed",
    description: "claims a request or booking is confirmed",
    pattern: /\b(?:confirm(?:ed|ada|ado|adas|ados)|confermed)\b/i,
  },
  {
    id: "booked",
    description: "claims something is booked or reserved on the guest's behalf",
    pattern: /\b(?:booked|reserv(?:ed|ada|ado|adas|ados))\b/i,
  },
  {
    id: "en_route",
    description: "claims a person or item is on the way",
    pattern: /\b(?:on (?:the|its|their|my|our) way|en camino|va en camino|ya (?:va|sali[oó]))\b/i,
  },
  {
    id: "done",
    description: "claims the work is done, complete or ready",
    pattern:
      /\b(?:done|completed|fulfilled|taken care of|all set|completad[oa]|listo|lista|hecho|realizad[oa]|atendid[oa]|resuelt[oa])\b/i,
  },
  {
    id: "guaranteed",
    description: "guarantees an outcome the product does not control",
    pattern: /\b(?:guarantee[ds]?|garantizad[oa]|garantizamos|asegurad[oa]|seguro que)\b/i,
  },
];

export interface FulfilmentClaim {
  ruleId: string;
  description: string;
  /** The offending text, short enough to read in a test failure. */
  excerpt: string;
}

const EXCERPT_LIMIT = 70;

export function findFulfilmentClaim(text: string): FulfilmentClaim[] {
  const claims: FulfilmentClaim[] = [];
  for (const rule of FULFILMENT_RULES) {
    const found = rule.pattern.exec(text);
    if (found === null) continue;
    claims.push({
      ruleId: rule.id,
      description: rule.description,
      excerpt: text.slice(Math.max(0, found.index - 20), found.index + EXCERPT_LIMIT).trim(),
    });
  }
  return claims;
}
