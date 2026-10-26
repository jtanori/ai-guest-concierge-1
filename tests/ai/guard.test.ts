/**
 * S05-02 / AC-1 + AC-2 — the checks a model cannot argue with.
 *
 * The cases are the failure modes that matter: a citation that was never
 * retrieved, a quote that exists nowhere in the cited text, an invented price,
 * an availability promise, "confirmed", a card number, and a confidence below a
 * calibrated floor. Each one must refuse and name a reason code.
 */
import { describe, expect, it } from "vitest";
import { normaliseForQuoteMatch, verifyAnswer } from "../../src/ai/guard.ts";
import { findBannedContent } from "../../src/ai/banned.ts";
import { classifySensitive, normalise } from "../../src/ai/sensitive.ts";
import { policyGate } from "../../src/ai/policy.ts";
import { passesLuhn, looksLikeCardNumber } from "../../src/security/pii.ts";
import type { AiOutput } from "../../src/ai/contract.ts";
import type { RetrievalHit } from "../../src/knowledge/retrieval.ts";
import { DEFAULT_SETTINGS, type PropertySettings } from "../../src/settings/schema.ts";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";

const BODY = "La alberca cierra a las 20:00 todos los días. El acceso es con llave.";
const CHUNK = "La alberca cierra a las 20:00 todos los días.";

function hit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    articleVersionId: V1,
    articleId: "33333333-3333-4333-8333-333333333333",
    topicKey: "pool.hours",
    title: "Alberca",
    body: BODY,
    language: "es",
    versionNo: 1,
    score: 0.5,
    scope: "property",
    matchedChunk: { chunkId: "c1", ordinal: 0, body: CHUNK },
    ...overrides,
  };
}

function answer(overrides: Partial<AiOutput> = {}): AiOutput {
  return {
    decision: "answer",
    answer: "La alberca cierra a las 20:00.",
    language: "es-MX",
    citations: [{ articleVersionId: V1, quote: "La alberca cierra a las 20:00" }],
    reasonCode: null,
    topicKeysUsed: ["pool.hours"],
    confidence: 0.9,
    ...overrides,
  };
}

describe("verifyAnswer (S05-02 AC-1)", () => {
  it("accepts an answer whose quote is in the cited chunk", () => {
    expect(verifyAnswer(answer(), [hit()])).toEqual({ ok: true });
  });

  it("accepts a quote that appears in the body but outside the matched chunk", () => {
    const result = verifyAnswer(
      answer({ citations: [{ articleVersionId: V1, quote: "El acceso es con llave" }] }),
      [hit()],
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a citation that was not retrieved", () => {
    const result = verifyAnswer(
      answer({ citations: [{ articleVersionId: V2, quote: "La alberca cierra a las 20:00" }] }),
      [hit()],
    );
    expect(result).toMatchObject({ ok: false, detail: "citation_check_failed" });
  });

  it("refuses a quote that exists nowhere in the cited version", () => {
    const result = verifyAnswer(
      answer({
        answer: "La alberca cierra a las 21:00.",
        citations: [{ articleVersionId: V1, quote: "La alberca cierra a las 21:00" }],
      }),
      [hit()],
    );
    expect(result).toMatchObject({ ok: false, detail: "quote_not_in_cited_version" });
    if (result.ok) throw new Error("unreachable");
    expect(result.violations[0]).toContain("does not appear");
  });

  it("is accent-, case- and punctuation-insensitive about the quote", () => {
    const accented = hit({ body: "El área de la alberca cierra a las 20:00.", matchedChunk: undefined });
    const result = verifyAnswer(
      answer({ citations: [{ articleVersionId: V1, quote: "AREA de la alberca, cierra" }] }),
      [accented],
    );
    expect(result.ok).toBe(true);
  });

  it("refuses banned content even when the citation is perfect", () => {
    const price = verifyAnswer(
      answer({ answer: "La entrada cuesta 450 MXN por persona.", citations: [{ articleVersionId: V1, quote: "El acceso es con llave" }] }),
      [hit()],
    );
    expect(price).toMatchObject({ ok: false, reasonCode: "policy_block" });
    if (price.ok) throw new Error("unreachable");
    expect(price.detail).toContain("currency_amount");

    for (const text of [
      "Your booking is confirmed for tonight.",
      "We have a room available tonight.",
      "Housekeeping is on the way.",
      "Tu reservación está confirmada.",
    ]) {
      const result = verifyAnswer(
        answer({ answer: text, citations: [{ articleVersionId: V1, quote: "El acceso es con llave" }] }),
        [hit()],
      );
      expect(result.ok, text).toBe(false);
    }
  });

  it("refuses a card number and never echoes it in the violation text", () => {
    const result = verifyAnswer(
      answer({
        answer: "Cobramos a la tarjeta 4111 1111 1111 1111.",
        citations: [{ articleVersionId: V1, quote: "El acceso es con llave" }],
      }),
      [hit()],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(JSON.stringify(result.violations)).not.toContain("4111");
  });

  it("applies a confidence floor only when one is configured", () => {
    const low = answer({ confidence: 0.3 });
    expect(verifyAnswer(low, [hit()]).ok).toBe(true);
    expect(verifyAnswer(low, [hit()], { minConfidence: 0.5 })).toMatchObject({
      ok: false,
      detail: "citation_check_failed",
    });
  });

  it("does not pretend a non-answer was verified", () => {
    const result = verifyAnswer(
      answer({ decision: "needs_human", answer: null, citations: [], reasonCode: "guest_asked_human" }),
      [hit()],
    );
    expect(result).toMatchObject({ ok: false, detail: "not_an_answer", reasonCode: "guest_asked_human" });
  });

  it("normalises for matching without losing meaning", () => {
    expect(normaliseForQuoteMatch("  La  ÁLBERCA, cierra… ")).toBe("la alberca cierra");
  });
});

describe("banned content (S05-02 AC-2)", () => {
  it("has no false positive on an ordinary hours answer", () => {
    expect(findBannedContent("La alberca cierra a las 20:00 y abre a las 07:00.")).toEqual([]);
    expect(findBannedContent("El spa abre a las 09:00; hay toallas disponibles en el área.")).toEqual([]);
  });

  it("detects prices in both currencies and languages", () => {
    for (const text of ["Cuesta $450.", "Son 1,200 MXN.", "Es 80 usd.", "Vale 300 pesos."]) {
      expect(findBannedContent(text).map((m) => m.ruleId), text).toContain("currency_amount");
    }
  });

  it("reports every violation, not just the first", () => {
    const matches = findBannedContent("Your booking is confirmed and it is 500 MXN, on the way.");
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("detects a Luhn-valid card and ignores a non-Luhn digit run", () => {
    expect(looksLikeCardNumber("4111 1111 1111 1111")).toBe(true);
    expect(looksLikeCardNumber("1234 5678 9012 3456")).toBe(false);
    expect(passesLuhn("4242424242424242")).toBe(true);
    expect(findBannedContent("tarjeta 4111111111111111")[0]?.excerpt).toBe("[redacted]");
  });
});

describe("sensitive topics (S05-02 AC-2)", () => {
  const cases: Array<[string, string]> = [
    ["Quiero un reembolso de la última noche", "sensitive_topic"],
    ["¿Hay algún médico en el hotel?", "sensitive_topic"],
    ["¿Tienen opciones sin gluten?", "sensitive_topic"],
    ["¿El hotel es accesible para silla de ruedas?", "sensitive_topic"],
    ["Quiero poner una queja por el ruido", "sensitive_topic"],
    ["¿Cuánto cuesta la habitación doble?", "booking_intent"],
    ["Do you have availability for tonight?", "booking_intent"],
    ["Quiero hablar con una persona", "guest_asked_human"],
    ["Can I speak to the manager?", "guest_asked_human"],
    // Found by the S06-03 harness: every one of these reached the model and was
    // answered before the rules covered the inflected form.
    ["Quiero cancelar y que me devuelvan el dinero", "sensitive_topic"],
    ["Creo que mi tarjeta se quedó cobrada dos veces", "sensitive_topic"],
    ["¿Pueden reservarme una mesa para cenar mañana a las ocho?", "booking_intent"],
    ["Can I get my money back for the last night?", "sensitive_topic"],
  ];

  it("classifies each sensitive family with a reason code", () => {
    for (const [text, reasonCode] of cases) {
      expect(classifySensitive(text, "es")?.reasonCode, text).toBe(reasonCode);
    }
  });

  it("lets the guest's explicit request for a person outrank our reading of intent", () => {
    expect(classifySensitive("Quiero hablar con el gerente sobre un reembolso", "es")).toMatchObject({
      ruleId: "guest_asked_human",
      reasonCode: "guest_asked_human",
    });
  });

  it("leaves ordinary questions alone", () => {
    for (const text of [
      "¿A qué hora cierra la alberca?",
      "¿Cuál es la contraseña del wifi?",
      "What time is breakfast served?",
      "¿Hay estacionamiento?",
    ]) {
      expect(classifySensitive(text, "es"), text).toBeNull();
    }
  });

  it("normalises accents and punctuation", () => {
    expect(normalise("¿MÉDICO?")).toBe("¿medico?");
    expect(classifySensitive("¿Hay recepción 24 horas?", "es")?.ruleId).toBe("guest_asked_human");
  });
});

describe("policy gate (S05-02)", () => {
  const settings: PropertySettings = { ...structuredClone(DEFAULT_SETTINGS), enabled_topics: ["pool.hours"] };
  const base = {
    settings,
    aiMode: "auto" as const,
    topicKey: "pool.hours",
    at: new Date("2026-03-02T18:00:00Z"),
    timeZone: "America/Mexico_City",
  };

  it("allows an enabled topic in auto mode", () => {
    expect(policyGate(base)).toMatchObject({ allow: true, reasonCode: null });
  });

  it("refuses draft and human_only regardless of topic", () => {
    expect(policyGate({ ...base, aiMode: "draft" })).toMatchObject({ allow: false, detail: "mode_draft" });
    expect(policyGate({ ...base, aiMode: "human_only" })).toMatchObject({
      allow: false,
      detail: "mode_human_only",
    });
  });

  it("refuses a topic the property has not enabled", () => {
    expect(policyGate({ ...base, topicKey: "spa.hours" })).toMatchObject({
      allow: false,
      detail: "topic_disabled",
    });
  });

  it("still applies the mode rules when no topic is known", () => {
    expect(policyGate({ ...base, topicKey: null })).toMatchObject({ allow: true, topicUnclassified: true });
    expect(policyGate({ ...base, topicKey: null, aiMode: "human_only" })).toMatchObject({
      allow: false,
      topicUnclassified: true,
    });
  });

  it("refuses when a spend counter says the cap is reached, and allows when it is unknown", () => {
    const caps = { dailyUsd: 25, perConversationUsd: 2 };
    const withCaps: PropertySettings = { ...settings, spend_cap: { daily_usd: caps.dailyUsd, per_conversation_usd: caps.perConversationUsd } };
    expect(policyGate({ ...base, settings: withCaps, spendTodayUsd: 24.99 }).allow).toBe(true);
    expect(policyGate({ ...base, settings: withCaps, spendTodayUsd: 25 })).toMatchObject({
      allow: false,
      detail: "daily_spend_cap",
    });
    expect(policyGate({ ...base, settings: withCaps, conversationSpendUsd: 2 })).toMatchObject({
      allow: false,
      detail: "conversation_spend_cap",
    });
  });
});
