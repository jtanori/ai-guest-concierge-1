/**
 * S05-02 / AC-2 — the topics that never get an auto-answer.
 *
 * This is a keyword classifier, and that is a deliberate choice rather than a
 * shortcut: a model asked to decide whether a question is "sensitive" is a
 * second opinion from the same source that is about to answer it, and it fails
 * silently when it is wrong. A fixed list of words is auditable, testable,
 * reviewable by a hotel manager, and cannot be talked out of a decision by a
 * persuasive guest. Its cost is recall on novel phrasings — which is why the
 * list is generous and bilingual, and why "unclassified" is not the same as
 * "safe": `policyGate` still applies the property's own rules.
 *
 * The reason codes are Appendix B's, and each maps to a real operating state:
 *
 *  - `sensitive_topic` — refunds, medical, accessibility, allergens, complaints.
 *    A wrong answer here is a safety or legal problem, not a service problem.
 *  - `booking_intent` — money, availability, prices. The guest wants to
 *    transact; the bot must hand over rather than improvise.
 *  - `guest_asked_human` — the guest asked for a person. Answering anyway is the
 *    single most complained-about behaviour of every hotel bot.
 */
import type { AiReasonCode } from "./contract.ts";
import type { Lang } from "../i18n/catalog.ts";

export interface SensitiveRule {
  id: string;
  reasonCode: AiReasonCode;
  /** Short operator-facing explanation, stored on the ai_runs row. */
  description: string;
  /** Lowercase, accent-stripped fragments. Matching is substring-on-words. */
  terms: readonly string[];
  /**
   * Spanish inflects by suffix: `reservar` and `reservarme` are one word to a
   * guest and two strings to a whole-word match, which is how the eval harness
   * caught "¿Pueden reservarme una mesa?" slipping past booking intent. A stem
   * is matched against the inside of a word, so it must stay short and specific
   * enough that an over-match is a deliberate choice rather than an accident.
   */
  stems?: readonly string[];
}

/** Accent- and case-insensitive form used for matching. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export const SENSITIVE_RULES: readonly SensitiveRule[] = [
  {
    id: "guest_asked_human",
    reasonCode: "guest_asked_human",
    description: "the guest asked for a person",
    terms: [
      "hablar con una persona", "hablar con alguien", "con una persona real",
      "recepcion", "reception", "gerente", "manager", "humano", "human",
      "agente", "agent", "atencion a clientes", "customer service",
      "talk to a person", "speak to someone", "real person", "front desk",
    ],
  },
  {
    id: "money_and_refunds",
    reasonCode: "sensitive_topic",
    description: "a refund, charge or invoice question",
    terms: [
      "reembolso", "refund", "devolucion", "devoluciones", "devolver",
      "devolverme", "devuelvan", "devuelveme", "reembolsar", "reembolsen",
      "reembolsame", "cobro", "cobraron", "cobrado", "cobrada", "cobran",
      "cobrando", "me cobraron", "doble cobro", "cobro doble",
      "cargo duplicado", "cobro duplicado", "me cobraron dos veces",
      "cargo", "charge", "charged", "charged twice", "double charge",
      "overcharged", "factura", "invoice", "recibo", "receipt", "contracargo",
      "chargeback", "descuento", "discount", "compensacion", "compensation",
      "reimburse", "money back", "get my money back",
    ],
    stems: ["reembols", "devolv", "devuelv", "cobr", "factur", "charg"],
  },
  {
    id: "medical",
    reasonCode: "sensitive_topic",
    description: "a medical or emergency question",
    terms: [
      "medico", "doctor", "hospital", "emergencia", "emergency", "ambulancia",
      "ambulance", "enfermeria", "nurse", "medicina", "medicine", "insulina",
      "insulin", "desfibrilador", "defibrillator", "alergia grave",
      "anaphyla", "anafilaxia", "embarazo", "pregnant",
    ],
  },
  {
    id: "allergens",
    reasonCode: "sensitive_topic",
    description: "an allergen question",
    terms: [
      "alergia", "alergico", "alergica", "allergy", "allergic", "gluten",
      "celiac", "celiaco", "cacahuate", "mani", "peanut", "nuez", "nuts",
      "lactosa", "lactose", "mariscos", "shellfish", "vegetariano", "vegan",
      "vegano",
    ],
  },
  {
    id: "accessibility",
    reasonCode: "sensitive_topic",
    description: "an accessibility question",
    terms: [
      "silla de ruedas", "wheelchair", "accesible", "accessible",
      "accesibilidad", "accessibility", "discapacidad", "disability", "rampa",
      "ramp", "braille", "lengua de senas", "sign language", "movilidad reducida",
    ],
  },
  {
    id: "complaint",
    reasonCode: "sensitive_topic",
    description: "a complaint about the stay",
    terms: [
      "queja", "complaint", "reclamo", "molestia", "molesto", "ruido", "noise",
      "sucio", "dirty", "roto", "broken", "no funciona", "not working",
      "mal servicio", "bad service", "insectos", "cucarachas", "bed bugs",
      "chinches", "inaceptable", "unacceptable", "hablar con el gerente",
    ],
  },
  {
    id: "booking_intent",
    reasonCode: "booking_intent",
    description: "a booking, price or availability intent",
    terms: [
      "reservar", "reservacion", "reservation", "reserve", "book a room",
      "booking", "disponibilidad", "availability", "disponible", "available",
      "cuanto cuesta", "cuanto es", "precio", "price", "tarifa", "rate",
      "how much", "habitacion para", "room for", "noches para", "stay tonight",
      "cambiar mi vuelo", "late checkout free", "upgrade gratis",
    ],
    // `reserv` covers reservar/reservarme/reservación/reservas; `cancel` covers
    // cancelar/cancelación; `disponib`/`disponibl` cover disponibilidad.
    stems: ["reserv", "cancel", "book", "disponib", "disponibl", "reserva"],
  },
];

export interface SensitiveMatch {
  ruleId: string;
  reasonCode: AiReasonCode;
  description: string;
  /** The term that fired. Safe to log: it is our own vocabulary, not the guest's text. */
  term: string;
}

/**
 * First matching rule, in the order above — so "quiero hablar con el gerente
 * sobre un reembolso" reports `guest_asked_human` rather than the refund rule:
 * the guest's explicit request outranks our reading of their intent.
 *
 * `language` is accepted for a future, language-specific rule set and is
 * currently unused: the terms are matched against normalised text in both
 * languages regardless, because a guest may mix them in one message.
 */
export function classifySensitive(text: string, language: Lang | null): SensitiveMatch | null {
  void language;
  // Punctuation becomes a word boundary: "¿Hay recepción?" and "recepcion"
  // must be the same question, and a trailing "?" would otherwise defeat the
  // space-delimited match.
  const haystack = ` ${normalise(text).replace(/[^a-z0-9]+/g, " ").trim()} `;
  const words = haystack.split(" ").filter((word) => word !== "");
  for (const rule of SENSITIVE_RULES) {
    for (const term of rule.terms) {
      if (haystack.includes(` ${term} `)) {
        return {
          ruleId: rule.id,
          reasonCode: rule.reasonCode,
          description: rule.description,
          term,
        };
      }
    }
    for (const stem of rule.stems ?? []) {
      const word = words.find((candidate) => candidate.includes(stem));
      if (word !== undefined) {
        return {
          ruleId: rule.id,
          reasonCode: rule.reasonCode,
          description: rule.description,
          term: `${word} (stem ${stem})`,
        };
      }
    }
  }
  return null;
}
