/**
 * S05-02 / S11-03 — PII detectors, shared.
 *
 * The first consumer is the guardrail layer (S05-02): a model that repeats a
 * guest's card number back into an answer must not have that answer sent. The
 * second consumer is log hygiene (S11-03), which is why this lives in
 * `src/security` rather than under `src/ai` — a redactor that only the AI layer
 * uses is a redactor that will be duplicated badly.
 *
 * Detection is deliberately conservative and structural: Luhn plus a plausible
 * length. A false positive costs an escalation, which is annoying; a false
 * negative sends a card number to a guest's chat thread, which is a breach.
 */
const DIGIT_RUN = /(?:\d[ -]?){13,19}/g;

/** Luhn check over the digits of `candidate`. */
export function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let value = digits.charCodeAt(index) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * True when `text` contains something that looks like a payment card number.
 * Requiring Luhn keeps a phone number or a room count from blocking an answer;
 * S05-02 turns a match into `policy_block`.
 */
export function looksLikeCardNumber(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    if (passesLuhn(match[0])) return true;
  }
  return false;
}

/**
 * S11-03 / AC-1 — the inbound half of card detection.
 *
 * Same rule as `looksLikeCardNumber` (the outbound guardrail's), under the name
 * the S11-03 charter uses, so the guest path and the answer path cannot drift into
 * two different definitions of "a card". Exported separately rather than renamed:
 * `banned.ts` publishes `looksLikeCardNumber` to the AI layer, and this is the
 * boundary where a guest's own message is inspected.
 */
export const containsCardLike = looksLikeCardNumber;

/** Placeholders are log data, never UI copy — deliberately not translated. */
const CARD = "[card]";
const EMAIL = "[email]";
const PHONE = "[phone]";

const EMAIL_RUN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * Phone-like: nine or more digits, optionally in one run with the usual
 * separators. Deliberately greedy — a false positive costs a masked number in a
 * log, a false negative leaves a guest's phone number in one, and only one of
 * those is a breach. A card is matched first, so a 16-digit number is never
 * reported as a phone.
 */
const PHONE_RUN = /\+?\d(?:[\d\s().-]{7,})\d/g;
/**
 * A UUID is not a phone number, and every log line in this product carries three of
 * them (`org_id`, `property_id`, `conversation_id` — W00-14's whole point). The phone
 * pattern above will happily eat `11111111-1111-5111-a111-111111111111`'s numeric
 * runs, so identifiers are lifted out before masking and put back afterwards. This
 * was not theoretical: the first version of this module turned every tenant id in
 * every line into `[phone]-a[phone]`, and the test that asserts a UUID survives is
 * what caught it.
 */
const UUID_RUN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** NUL cannot appear in a log line's text, so it is a safe sentinel. */
const SENTINEL = String.fromCharCode(0);
const UUID_PLACEHOLDER = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g");

/**
 * S11-03 — mask the PII a log line could otherwise carry.
 *
 * Order matters. Cards first (a 16-digit Luhn-valid run is a card, not a phone),
 * then emails, then what remains of phone-like runs. Placeholders contain no
 * digits, so a later pass cannot re-match an earlier replacement.
 */
export function maskPii(value: string): string {
  const identifiers: string[] = [];
  const withPlaceholders = value.replace(UUID_RUN, (uuid) => {
    identifiers.push(uuid);
    return `${SENTINEL}${identifiers.length - 1}${SENTINEL}`;
  });

  const maskedCards = withPlaceholders.replace(/(?:\d[ -]?){13,19}/g, (candidate) =>
    looksLikeCardNumber(candidate) ? CARD : candidate,
  );
  const maskedEmails = maskedCards.replace(EMAIL_RUN, EMAIL);
  const maskedPhones = maskedEmails.replace(PHONE_RUN, (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    // Nine digits is the floor: below that it is a room number, a price or a time.
    return digits.length >= 9 ? PHONE : candidate;
  });

  return maskedPhones.replace(UUID_PLACEHOLDER, (_match, index: string) => identifiers[Number(index)]!);
}

/** True when `maskPii` would change the text. Used by the fixture test. */
export function containsPii(text: string): boolean {
  return maskPii(text) !== text;
}
