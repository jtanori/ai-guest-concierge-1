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
  // S08-02 — the conversation detail. The sources pane is the point of the
  // screen: "quoted" is the sentence the model leaned on, the body is where it
  // came from, and "no longer current" is the honest label for an answer that
  // cites history (which is correct, not broken).
  "staff.inbox.back": "Back to the inbox",
  "staff.inbox.transcript": "Conversation",
  "staff.inbox.sources": "Sources",
  "staff.inbox.no_sources": "This answer cited nothing.",
  "staff.inbox.quote": "Quoted",
  "staff.inbox.article_version": "Version {number} of {title}",
  "staff.inbox.not_current": "No longer the current version",
  "staff.inbox.model": "Model",
  "staff.inbox.prompt_version": "Prompt",
  "staff.inbox.decision": "Decision",
  "staff.inbox.reason": "Reason",
  "staff.inbox.confidence": "Confidence",
  "staff.inbox.decision_answer": "Answered",
  "staff.inbox.decision_escalate": "Escalated",
  "staff.inbox.decision_no_answer": "No answer",
  "staff.inbox.author_guest": "Guest",
  "staff.inbox.author_ai": "Assistant",
  "staff.inbox.author_staff": "Staff",
  "staff.inbox.requests": "Requests from this conversation",
  "staff.inbox.no_requests": "This conversation opened no requests.",
  "staff.inbox.not_found": "That conversation does not exist.",
  "staff.inbox.problem_invalid": "The message was empty or too long.",
  "staff.inbox.problem_forbidden": "Your role cannot do that.",
  "staff.inbox.problem_missing": "That conversation changed or no longer exists.",
  "staff.inbox.problem_conflict": "Someone else got there first. Reload and try again.",
  "staff.inbox.problem_error": "That didn't work. Try again.",
  "staff.inbox.reply": "Reply as staff",
  "staff.inbox.reply_hint":
    "Sending takes the conversation over: the assistant stops replying until a guest writes again.",
  "staff.inbox.send": "Send",
  "staff.inbox.take_over": "Take over",
  "staff.inbox.take_over_hint": "The assistant stops replying on this conversation.",
  "staff.inbox.resolve": "Resolve",
  "staff.inbox.resolve_hint": "Closes the conversation and any request it opened.",
  "staff.inbox.assign_me": "Assign to me",
  // S09-01 — acknowledgement is its own edge, so it gets its own button: it is
  // the moment a person takes responsibility for having *seen* this, which is a
  // different fact from being handed the work (assign) or finishing it (resolve).
  // Without the button the only way to acknowledge was to assign, and then the
  // time-to-acknowledge metric would have measured time-to-assignment instead.
  "staff.inbox.acknowledge": "Acknowledge",
  "staff.inbox.acknowledge_hint":
    "Records that a person has seen this request. Assigning and resolving come after.",
  "staff.inbox.cancel_request": "Cancel request",
  "staff.inbox.actions": "Actions",
  "staff.mode.nav": "Settings",
  // S08-04 — the operating mode. The hints are the whole product decision: an
  // admin who does not know that "draft" still answers the guest (into the queue)
  // will turn it on expecting silence.
  "staff.mode.title": "Assistant mode",
  "staff.mode.intro": "Applies from the next guest message. No deploy, no restart.",
  "staff.mode.current": "Current mode",
  "staff.mode.auto": "Automatic",
  "staff.mode.auto_hint": "The assistant answers enabled topics itself and escalates the rest.",
  "staff.mode.draft": "Draft for staff",
  "staff.mode.draft_hint": "Nothing is sent to the guest by the model; every message goes to the queue.",
  "staff.mode.human_only": "Staff only",
  "staff.mode.human_only_hint": "The model never replies. Guests are told a person will answer.",
  "staff.mode.after_hours": "After hours only",
  "staff.mode.after_hours_hint": "The assistant answers outside business hours; staff handle the rest.",
  "staff.mode.timezone": "Business hours are read in {zone}.",
  "staff.mode.save": "Save mode",
  "staff.mode.saved": "Saved. The next guest message uses the new mode.",
  "staff.mode.unchanged": "That was already the mode.",
  "staff.mode.error_invalid": "That is not a mode this property can run.",
  "staff.mode.error_forbidden": "Your role cannot change the mode.",
  "staff.mode.error_other": "That didn't save. Try again.",
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
  "staff.inbox.back": "Volver a la bandeja",
  "staff.inbox.transcript": "Conversación",
  "staff.inbox.sources": "Fuentes",
  "staff.inbox.no_sources": "Esta respuesta no citó nada.",
  "staff.inbox.quote": "Cita",
  "staff.inbox.article_version": "Versión {number} de {title}",
  "staff.inbox.not_current": "Ya no es la versión vigente",
  "staff.inbox.model": "Modelo",
  "staff.inbox.prompt_version": "Prompt",
  "staff.inbox.decision": "Decisión",
  "staff.inbox.reason": "Motivo",
  "staff.inbox.confidence": "Confianza",
  "staff.inbox.decision_answer": "Respondida",
  "staff.inbox.decision_escalate": "Escalada",
  "staff.inbox.decision_no_answer": "Sin respuesta",
  "staff.inbox.author_guest": "Huésped",
  "staff.inbox.author_ai": "Asistente",
  "staff.inbox.author_staff": "Personal",
  "staff.inbox.requests": "Solicitudes de esta conversación",
  "staff.inbox.no_requests": "Esta conversación no abrió solicitudes.",
  "staff.inbox.not_found": "Esa conversación no existe.",
  "staff.inbox.problem_invalid": "El mensaje estaba vacío o era demasiado largo.",
  "staff.inbox.problem_forbidden": "Su rol no permite esa acción.",
  "staff.inbox.problem_missing": "Esa conversación cambió o ya no existe.",
  "staff.inbox.problem_conflict": "Alguien más llegó primero. Recargue e inténtelo de nuevo.",
  "staff.inbox.problem_error": "No funcionó. Inténtelo de nuevo.",
  "staff.inbox.reply": "Responder como personal",
  "staff.inbox.reply_hint":
    "Al enviar toma la conversación: el asistente deja de responder hasta que el huésped vuelva a escribir.",
  "staff.inbox.send": "Enviar",
  "staff.inbox.take_over": "Tomar la conversación",
  "staff.inbox.take_over_hint": "El asistente deja de responder en esta conversación.",
  "staff.inbox.resolve": "Resolver",
  "staff.inbox.resolve_hint": "Cierra la conversación y cualquier solicitud que haya abierto.",
  "staff.inbox.assign_me": "Asignármela",
  "staff.inbox.acknowledge": "Acusar recibo",
  "staff.inbox.acknowledge_hint":
    "Registra que una persona ya vio esta solicitud. Asignar y resolver vienen después.",
  "staff.inbox.cancel_request": "Cancelar solicitud",
  "staff.inbox.actions": "Acciones",
  "staff.mode.nav": "Configuración",
  "staff.mode.title": "Modo del asistente",
  "staff.mode.intro": "Se aplica desde el siguiente mensaje del huésped. Sin despliegue ni reinicio.",
  "staff.mode.current": "Modo actual",
  "staff.mode.auto": "Automático",
  "staff.mode.auto_hint": "El asistente responde los temas habilitados y escala el resto.",
  "staff.mode.draft": "Borrador para el personal",
  "staff.mode.draft_hint": "El modelo no envía nada al huésped; cada mensaje va a la bandeja.",
  "staff.mode.human_only": "Solo personal",
  "staff.mode.human_only_hint": "El modelo nunca responde. Se avisa al huésped que una persona contestará.",
  "staff.mode.after_hours": "Solo fuera de horario",
  "staff.mode.after_hours_hint": "El asistente responde fuera del horario de atención; el resto lo atiende el personal.",
  "staff.mode.timezone": "El horario de atención se lee en {zone}.",
  "staff.mode.save": "Guardar modo",
  "staff.mode.saved": "Guardado. El siguiente mensaje del huésped usa el modo nuevo.",
  "staff.mode.unchanged": "Ese ya era el modo.",
  "staff.mode.error_invalid": "Ese no es un modo que esta propiedad pueda usar.",
  "staff.mode.error_forbidden": "Su rol no puede cambiar el modo.",
  "staff.mode.error_other": "No se guardó. Inténtelo de nuevo.",
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
