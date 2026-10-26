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
  /** S07-01: origins allowed to frame the chat (settings `embed`). */
  frameAncestors: string[];
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

/**
 * S07-02 — the wire shape of one tap. There is no `messages` array: a handoff
 * answers with exactly the acknowledgement it stored, and the client appends it.
 */
export interface GuestHandoffWire {
  property: PublicPropertyWire;
  conversationId: string;
  message: GuestMessageWire;
  decision: "handoff";
  reasonCode: "guest_asked_human";
  language: "es" | "en";
  requestId: string;
  requestCreated: boolean;
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

/** S07-02: one tap. Same tenant and language inputs, no body. */
export function handoffPath(slug: string, lang: string): string {
  return `/api/chat/handoff?property=${encodeURIComponent(slug)}&lang=${encodeURIComponent(lang)}`;
}

/**
 * S07-04 — the one interpolation in guest copy.
 *
 * The retry countdown is only known in the browser (it comes from the 429 that
 * just happened), so the catalogue holds the sentence with a `{seconds}` hole in
 * it and this fills the hole. Kept here rather than in the component so both the
 * English and the Spanish sentence are formatted by the same line of code.
 */
export function retryMessage(template: string, seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 30;
  return template.split("{seconds}").join(String(safe));
}
