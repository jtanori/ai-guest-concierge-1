/**
 * S06-01 — the guest chat's wire shapes and its one address.
 *
 * These mirror `src/guest/http.ts`. They are declared here rather than imported
 * because the API's dates are ISO strings over JSON while the service works with
 * `Date` objects — the same reason `lib/types.ts` mirrors the review surface.
 */
/*
 * No `apiBase` here on purpose: this module is imported by a CLIENT component,
 * and the API's address is a server-side detail (`next/headers` in `session.ts`
 * is server-only). The browser builds relative paths and the proxy route
 * (`app/api/chat/[...path]/route.ts`) resolves them server-side.
 */

export interface GuestMessageWire {
  messageId: string;
  direction: "inbound" | "outbound";
  authorRole: "guest" | "ai" | "staff";
  body: string;
  createdAt: string;
}

export interface PublicPropertyWire {
  slug: string;
  name: string;
  languages: string[];
  disclosure: string;
  talkToPerson: string;
}

export interface GuestTurnWire {
  property: PublicPropertyWire;
  conversationId: string;
  messages: GuestMessageWire[];
  /** `handoff`: a human owns the thread (S06-02), so the model stayed silent. */
  decision: "answer" | "fact" | "escalate" | "no_answer" | "unavailable" | "handoff";
  reasonCode: string | null;
  language: "es" | "en";
}

export interface GuestTranscriptWire {
  property: PublicPropertyWire;
  conversationId: string | null;
  messages: GuestMessageWire[];
}

export interface ApiFailure {
  error: string;
  detail?: string;
}

/** `?property=` is the only tenant input the API accepts — never a body field. */
export function messagesPath(slug: string, lang: string): string {
  return `/api/chat/messages?property=${encodeURIComponent(slug)}&lang=${encodeURIComponent(lang)}`;
}
