// D14 — the string catalogue exists from the first commit. No hardcoded copy
// anywhere in any UI; every string is a lookup through this catalog in
// Spanish and English. Add ids to BOTH languages or typecheck fails the
// key-parity test.
export type Lang = "en" | "es";

export const LANGUAGES: readonly Lang[] = ["en", "es"] as const;

export const en = {
  "guest.ai_disclosure":
    "I'm the hotel's virtual concierge. I can connect you with a person at any time.",
  "guest.talk_to_person": "Talk to a person",
  "guest.idontknow":
    "I don't want to guess on that one — I've asked the front desk to reply directly.",
  "staff.inbox.title": "Inbox",
  "staff.inbox.needs_attention": "Needs attention",
  "staff.inbox.mine": "Mine",
  "staff.inbox.unresolved": "Unresolved",
} as const;

export type StringId = keyof typeof en;

// Spanish must mirror English key-for-key. Record<StringId, string> makes a
// missing or extra key a compile error.
export const es: Record<StringId, string> = {
  "guest.ai_disclosure":
    "Soy el conserje virtual del hotel. Puedo ponerlo en contacto con una persona en cualquier momento.",
  "guest.talk_to_person": "Hablar con una persona",
  "guest.idontknow":
    "No quiero adivinar en esa — le pedí a recepción que le responda directamente.",
  "staff.inbox.title": "Bandeja",
  "staff.inbox.needs_attention": "Requieren atención",
  "staff.inbox.mine": "Mías",
  "staff.inbox.unresolved": "Sin resolver",
};

// Index with a readonly lookup; unknown ids are a type error, not an
// undefined at runtime.
const catalog: Record<Lang, Readonly<Record<StringId, string>>> = { en, es };

export function t(id: StringId, lang: Lang = "es"): string {
  return catalog[lang][id];
}
