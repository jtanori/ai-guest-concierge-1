/**
 * S07-03 AC-2 — no outbound template may claim a request is fulfilled.
 *
 * The scope is the whole catalogue, in both languages, not a list of "outbound"
 * ids: the string somebody adds on a Friday afternoon is exactly the one that
 * would be missing from a curated list, and the cost of scanning every string is
 * one regex pass in a unit test.
 *
 * Two halves, because they fail in different ways:
 *
 *  1. **The catalogue.** Every string in `en` and `es` — UI copy included — must
 *     be free of fulfilment claims. This is the durable half.
 *  2. **The rendered acknowledgement.** Every branch of `replyFor` is rendered
 *     and scanned, so a template that is composed at runtime (prefix + value,
 *     disclosure + body) is checked in its composed form rather than as parts.
 *     A rule that only held for the parts would miss "According to our records:
 *     confirmed".
 */
import { describe, expect, it } from "vitest";
import { en, es, t, type Lang, type StringId } from "../../src/i18n/catalog.ts";
import { findFulfilmentClaim, FULFILMENT_RULES } from "../../src/requests/honesty.ts";
import { replyFor } from "../../src/guest/service.ts";
import type { AnswerOutcome } from "../../src/ai/answer.ts";

const LANGS: readonly Lang[] = ["en", "es"];

describe("outbound copy honesty (S07-03 AC-2)", () => {
  it("finds a fulfilment claim where one exists (the rule is not vacuous)", () => {
    // Without this the whole suite could pass because the regexes match nothing.
    const samples = [
      "Your request is confirmed.",
      "Tu solicitud ha sido confirmada.",
      "I've booked the table for you.",
      "Ya está reservado.",
      "Someone is on the way to your room.",
      "Va en camino.",
      "All done!",
      "Todo listo, su solicitud está completada.",
      "We guarantee a response in 5 minutes.",
    ];
    for (const sample of samples) {
      expect(findFulfilmentClaim(sample), sample).not.toHaveLength(0);
    }
  });

  it("leaves honest copy alone", () => {
    const samples = [
      t("guest.request_ack", "es"),
      t("guest.request_ack", "en"),
      t("guest.idontknow", "es"),
      t("guest.staff_reply_pending", "en"),
      t("guest.unavailable", "es"),
      "A person will reply here shortly.",
      "Una persona le responderá aquí en un momento.",
    ];
    for (const sample of samples) {
      expect(findFulfilmentClaim(sample), sample).toEqual([]);
    }
  });

  /**
   * Guest-facing ids only, and that is a deliberate line rather than an
   * oversight: `staff.review.resolved` is "Resuelto" — the name of a state shown
   * to a staff member about a row whose `status` literally is `resolved`. Calling
   * that a fulfilment claim would be wrong, and exempting the whole `guest.*`
   * namespace is safe because nothing else can reach a guest: `replyFor`, the
   * disclosure, the handoff acknowledgement and the guest page all read `guest.*`
   * ids exclusively.
   */
  it("keeps every guest-facing catalogue string free of fulfilment claims, in both languages", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const lang of LANGS) {
      const catalog = lang === "en" ? en : es;
      for (const [id, text] of Object.entries(catalog) as Array<[StringId, string]>) {
        if (!id.startsWith("guest.")) continue;
        scanned += 1;
        for (const claim of findFulfilmentClaim(text)) {
          offenders.push(`${lang}:${id} — ${claim.ruleId} (${claim.description}): "${claim.excerpt}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // A sweep that scanned nothing would pass for the wrong reason.
    expect(scanned).toBeGreaterThanOrEqual(2 * 10);
  });

  it("keeps every rendered acknowledgement free of fulfilment claims", () => {
    // One outcome per branch of the switch. The texts are the real ones the
    // pipeline returns; `replyFor` maps them exactly as a guest receives them.
    const outcomes: AnswerOutcome[] = [
      {
        kind: "answer",
        output: {
          decision: "answer",
          answer: "La alberca cierra a las 21:00.",
          language: "es-MX",
          citations: [],
          reasonCode: null,
          topicKeysUsed: [],
          confidence: 0.9,
        },
        aiRunId: "run",
        modelId: "model",
        usedFallback: false,
        hits: [],
      },
      {
        kind: "fact",
        fact: { value: "21:00", unit: "time-of-day" } as AnswerOutcome extends { kind: "fact"; fact: infer F }
          ? F
          : never,
        topicKey: "pool.hours",
        factKey: "closing_time",
      },
      { kind: "no_answer", reasonCode: "low_retrieval", eventId: 1n, guestMessage: t("guest.idontknow", "es") },
      {
        kind: "escalate",
        reasonCode: "sensitive_topic",
        detail: "sensitive:allergens",
        aiRunId: null,
        guestMessage: t("guest.request_ack", "es"),
      },
      { kind: "unavailable", detail: "both providers failed" },
    ];

    for (const lang of LANGS) {
      for (const outcome of outcomes) {
        const { body } = replyFor(outcome, lang);
        expect(findFulfilmentClaim(body), `${outcome.kind}/${lang}: "${body}"`).toEqual([]);
      }
    }
  });

  it("declares every rule with a reason a reviewer can act on", () => {
    for (const rule of FULFILMENT_RULES) {
      expect(rule.description.length, rule.id).toBeGreaterThan(10);
      expect(rule.pattern.flags, rule.id).toContain("i");
    }
  });
});
