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
  "guest.staff_reply_pending":
    "A member of our team has this conversation and will reply here shortly.",
  "guest.unavailable":
    "I can't answer right now, but I've passed this to the team — a person will reply here shortly.",
  "guest.fact_prefix": "According to our records: ",
  "guest.chat.heading": "Concierge",
  "guest.chat.empty": "Ask us anything about your stay.",
  "guest.chat.placeholder": "Write your question",
  "guest.chat.send": "Send",
  "guest.chat.error": "That message didn't go through. Please try again.",
  // S07-04: the two ways the server can refuse a message. Never a 5xx and never
  // a silent drop: a guest who is told to wait 30 seconds waits, and a guest who
  // is told a bot check is needed can complete it.
  "guest.chat.rate_limited":
    "That was a lot of messages at once. Please wait a moment and send it again.",
  "guest.chat.rate_limited_seconds":
    "That was a lot of messages at once. Please wait {seconds} seconds and send it again.",
  "guest.chat.bot_check":
    "We couldn't confirm this is a real browser. Please reload the page and try again.",
  "guest.idontknow":
    "I don't want to guess on that one — I've asked the front desk to reply directly.",
  // S07-03: sent when a request was captured for a reason other than a missing
  // article (money, a booking, a medical or accessibility question, an outage).
  // It says what happened — the request exists — and promises nothing more.
  "guest.request_ack":
    "I've passed this to our team. A person will reply here, and you'll see their answer in this chat.",
  "staff.common.brand": "Staff console",
  "staff.inbox.title": "Inbox",
  "staff.inbox.needs_attention": "Needs attention",
  "staff.inbox.mine": "Mine",
  "staff.inbox.unresolved": "Unresolved",
  // S08-01 — the inbox screen. Wait times are relative and short on purpose: a
  // phone at a front desk should read "4 min", not a timestamp it has to do
  // arithmetic on.
  "staff.inbox.empty": "Nothing waiting here.",
  "staff.inbox.error": "That didn't load. Try again.",
  "staff.inbox.forbidden": "Your role can't read the queue.",
  "staff.inbox.wait_now": "just now",
  "staff.inbox.wait_minutes": "{count} min waiting",
  "staff.inbox.wait_hours": "{count} h waiting",
  "staff.inbox.wait_days": "{count} d waiting",
  "staff.inbox.no_messages": "No messages yet",
  "staff.inbox.load_more": "Load more",
  "staff.inbox.state_awaiting_staff": "Waiting for a person",
  "staff.inbox.state_awaiting_ai": "With the assistant",
  "staff.inbox.state_idle": "Idle",
  "staff.inbox.state_resolved": "Resolved",
  "staff.inbox.request_status_new": "Request: new",
  "staff.inbox.request_status_acknowledged": "Request: acknowledged",
  "staff.inbox.request_status_assigned": "Request: assigned",
  "staff.inbox.request_status_resolved": "Request: resolved",
  "staff.inbox.request_status_cancelled": "Request: cancelled",
  "staff.common.signout": "Sign out",
  "staff.review.title": "Review queue",
  "staff.review.pending": "Waiting for approval",
  "staff.review.approve": "Approve",
  "staff.review.reject": "Reject",
  "staff.review.approved": "Approved",
  "staff.review.rejected": "Rejected",
  "staff.review.contradictions": "Conflicting answers",
  "staff.review.resolve": "Choose this answer",
  "staff.review.resolved": "Resolved",
  "staff.review.empty": "Nothing to review",
  "staff.review.article": "Article",
  "staff.review.version": "Version",
  "staff.review.value": "Value",
  "staff.review.winner": "Winner",
  "staff.review.error": "That didn't work. Try again.",
  "staff.review.forbidden": "Your role can't make this decision.",
  "staff.review.signout": "Sign out",
  "staff.session.title": "Staff sign-in",
  "staff.session.token": "Access token",
  "staff.session.org": "Organization id",
  "staff.session.property": "Property id",
  "staff.session.submit": "Continue",
  "staff.session.missing": "Sign in to continue.",
  "staff.session.language": "Language",
  "staff.session.help":
    "Paste the token your identity provider issued for you. It is stored in an HttpOnly cookie and never in the browser's storage.",
} as const;

export type StringId = keyof typeof en;

// Spanish must mirror English key-for-key. Record<StringId, string> makes a
// missing or extra key a compile error.
export const es: Record<StringId, string> = {
  "guest.ai_disclosure":
    "Soy el conserje virtual del hotel. Puedo ponerlo en contacto con una persona en cualquier momento.",
  "guest.talk_to_person": "Hablar con una persona",
  "guest.staff_reply_pending":
    "Un miembro de nuestro equipo tiene esta conversación y le responderá por aquí en breve.",
  "guest.unavailable":
    "No puedo responder en este momento, pero ya lo pasé al equipo: una persona le responderá por aquí en breve.",
  "guest.fact_prefix": "Según nuestro registro: ",
  "guest.chat.heading": "Conserje",
  "guest.chat.empty": "Pregúntenos lo que necesite sobre su estancia.",
  "guest.chat.placeholder": "Escriba su pregunta",
  "guest.chat.send": "Enviar",
  "guest.chat.error": "El mensaje no se envió. Inténtelo de nuevo.",
  "guest.chat.rate_limited":
    "Fueron muchos mensajes a la vez. Espere un momento y envíelo otra vez.",
  "guest.chat.rate_limited_seconds":
    "Fueron muchos mensajes a la vez. Espere {seconds} segundos y envíelo otra vez.",
  "guest.chat.bot_check":
    "No pudimos confirmar que es un navegador real. Recargue la página e inténtelo de nuevo.",
  "guest.idontknow":
    "No quiero adivinar en esa — le pedí a recepción que le responda directamente.",
  "guest.request_ack":
    "Ya lo pasé a nuestro equipo. Una persona le responderá aquí y verá su respuesta en este chat.",
  "staff.common.brand": "Consola del personal",
  "staff.inbox.title": "Bandeja",
  "staff.inbox.needs_attention": "Requieren atención",
  "staff.inbox.mine": "Mías",
  "staff.inbox.unresolved": "Sin resolver",
  "staff.inbox.empty": "No hay nada esperando aquí.",
  "staff.inbox.error": "No se pudo cargar. Inténtelo de nuevo.",
  "staff.inbox.forbidden": "Su rol no puede ver la cola.",
  "staff.inbox.wait_now": "ahora mismo",
  "staff.inbox.wait_minutes": "{count} min esperando",
  "staff.inbox.wait_hours": "{count} h esperando",
  "staff.inbox.wait_days": "{count} d esperando",
  "staff.inbox.no_messages": "Sin mensajes todavía",
  "staff.inbox.load_more": "Cargar más",
  "staff.inbox.state_awaiting_staff": "Esperando a una persona",
  "staff.inbox.state_awaiting_ai": "Con el asistente",
  "staff.inbox.state_idle": "Inactiva",
  "staff.inbox.state_resolved": "Resuelta",
  "staff.inbox.request_status_new": "Solicitud: nueva",
  "staff.inbox.request_status_acknowledged": "Solicitud: reconocida",
  "staff.inbox.request_status_assigned": "Solicitud: asignada",
  "staff.inbox.request_status_resolved": "Solicitud: resuelta",
  "staff.inbox.request_status_cancelled": "Solicitud: cancelada",
  "staff.common.signout": "Cerrar sesión",
  "staff.review.title": "Cola de revisión",
  "staff.review.pending": "Pendiente de aprobación",
  "staff.review.approve": "Aprobar",
  "staff.review.reject": "Rechazar",
  "staff.review.approved": "Aprobado",
  "staff.review.rejected": "Rechazado",
  "staff.review.contradictions": "Respuestas contradictorias",
  "staff.review.resolve": "Elegir esta respuesta",
  "staff.review.resolved": "Resuelto",
  "staff.review.empty": "Nada por revisar",
  "staff.review.article": "Artículo",
  "staff.review.version": "Versión",
  "staff.review.value": "Valor",
  "staff.review.winner": "Ganador",
  "staff.review.error": "No funcionó. Inténtalo de nuevo.",
  "staff.review.forbidden": "Tu rol no puede tomar esta decisión.",
  "staff.review.signout": "Salir",
  "staff.session.title": "Acceso del personal",
  "staff.session.token": "Token de acceso",
  "staff.session.org": "Id de la organización",
  "staff.session.property": "Id de la propiedad",
  "staff.session.submit": "Continuar",
  "staff.session.missing": "Inicia sesión para continuar.",
  "staff.session.language": "Idioma",
  "staff.session.help":
    "Pega el token que tu proveedor de identidad emitió para ti. Se guarda en una cookie HttpOnly, nunca en el almacenamiento del navegador.",
};

// Index with a readonly lookup; unknown ids are a type error, not an
// undefined at runtime.
const catalog: Record<Lang, Readonly<Record<StringId, string>>> = { en, es };

export function t(id: StringId, lang: Lang = "es"): string {
  return catalog[lang][id];
}
