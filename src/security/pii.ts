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
