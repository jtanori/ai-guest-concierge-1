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
  // S11-03 — the guest pasted something that looks like a card number. The turn is
  // refused before anything is stored or logged; this sentence is the whole of what
  // the guest sees, and it says what to do next rather than scolding.
  "guest.chat.card_refused":
    "That message looks like it contains a card number, so we didn't send or store it. Please write your question again without the card details — never share card numbers in chat.",
  "guest.idontknow":
    "I don't want to guess on that one — I've asked the front desk to reply directly.",
  // S07-03: sent when a request was captured for a reason other than a missing
  // article (money, a booking, a medical or accessibility question, an outage).
  // It says what happened — the request exists — and promises nothing more.
  "guest.request_ack":
    "I've passed this to our team. A person will reply here, and you'll see their answer in this chat.",
  "staff.common.brand": "Staff console",
  "staff.inbox.title": "Inbox",
  // S11-03 — retention window passed; the row is kept, the text is gone.
  "staff.inbox.message_redacted":
    "The text of this message was deleted after the property's retention window. The conversation and its counts are kept.",
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
  // S09-03 — "wrong or outdated". The label names both failure modes because they
  // have different fixes (a bad article vs a stale one) and the person clicking
  // often cannot tell which it is yet; the note is where they say more.
  "staff.flag.button": "Wrong or outdated",
  "staff.flag.hint": "One click. Add a note only if you have one.",
  "staff.flag.flagged": "Flagged by {count}",
  "staff.flag.flagged_one": "Flagged by 1 person",
  "staff.flag.flagged_by_you": "You flagged this",
  "staff.flag.note_placeholder": "What is wrong with it? (optional)",
  "staff.flag.your_note": "Your note",
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
  // S09-02 — the knowledge-gap queue. This is the screen a content owner reads to
  // decide what to write next, so the copy carries the two numbers that make it a
  // queue rather than a list: how many guests hit the miss, and how long it has
  // been sitting. The median is labelled with its target because a number with no
  // target is a number nobody acts on.
  "staff.gaps.nav": "Gaps",
  "staff.gaps.title": "Knowledge gaps",
  "staff.gaps.intro":
    "What guests asked that the assistant could not answer. Close one once the content exists.",
  "staff.gaps.median": "Median time open",
  "staff.gaps.median_days": "{days} days",
  "staff.gaps.median_none": "Nothing open",
  "staff.gaps.target": "Target: 7 days or less",
  "staff.gaps.open_count": "{count} open",
  "staff.gaps.hits": "Asked {count} times",
  "staff.gaps.hits_one": "Asked once",
  "staff.gaps.age_minutes": "open {count} min",
  "staff.gaps.age_hours": "open {count} h",
  "staff.gaps.age_days": "open {count} d",
  "staff.gaps.close": "Close",
  "staff.gaps.close_hint": "Say the content now answers this. Guests asking again reopen it.",
  "staff.gaps.conversation": "See the conversation",
  "staff.gaps.empty": "Nothing unanswered.",
  "staff.gaps.load_more": "Load more",
  "staff.gaps.error": "That didn't load. Try again.",
  "staff.gaps.forbidden": "Your role can't read the gaps.",
  "staff.gaps.problem_invalid": "That request was not valid.",
  "staff.gaps.problem_forbidden": "Your role cannot close a gap.",
  "staff.gaps.problem_missing": "That gap changed or no longer exists.",
  "staff.gaps.problem_conflict": "Someone else got there first. Reload and try again.",
  "staff.gaps.problem_error": "That didn't work. Try again.",
  // S10-03 — the management dashboard. Every tile is a stored `rollups` row, so
  // the copy says what the number counts; the screen's promise is traceability
  // (each tile names its metric and prints the query), not decoration.
  "staff.analytics.nav": "Analytics",
  "staff.analytics.title": "Daily numbers",
  "staff.analytics.intro":
    "One row per day per metric, computed from the product's own events. Every tile shows the query that produced it.",
  "staff.analytics.from": "From",
  "staff.analytics.to": "To",
  "staff.analytics.show": "Show",
  "staff.analytics.show_query": "Show the query",
  "staff.analytics.metric": "Metric",
  "staff.analytics.stored": "Stored value",
  "staff.analytics.no_data": "No data for this day",
  "staff.analytics.empty": "Nothing has been rolled up for these days yet.",
  "staff.analytics.computed": "Last computed {at}",
  "staff.analytics.timezone": "Days are read in {zone}.",
  "staff.analytics.recent": "Recent days",
  "staff.analytics.error": "The numbers didn't load. Try again.",
  "staff.analytics.forbidden": "Your role can't read analytics.",
  "staff.analytics.problem_invalid": "That date range is not valid.",
  "staff.analytics.tile.conversations_started": "Conversations",
  "staff.analytics.hint.conversations_started": "Conversations a guest opened.",
  "staff.analytics.tile.messages_received": "Guest messages",
  "staff.analytics.hint.messages_received": "Messages guests sent.",
  "staff.analytics.tile.ai_answers_sent": "AI answers",
  "staff.analytics.hint.ai_answers_sent": "Answers the assistant sent on its own.",
  "staff.analytics.tile.escalations": "Handed to a person",
  "staff.analytics.hint.escalations": "Answers handed to a person.",
  "staff.analytics.tile.no_answers": "No answer",
  "staff.analytics.hint.no_answers":
    "Questions the assistant could not answer from the articles.",
  "staff.analytics.tile.containment": "Containment",
  "staff.analytics.hint.containment":
    "Share of conversations that never needed a staff message.",
  "staff.analytics.tile.first_response_p95_seconds": "First response p95",
  "staff.analytics.hint.first_response_p95_seconds":
    "95% of guests were answered within this time.",
  "staff.analytics.tile.requests_created": "Requests",
  "staff.analytics.hint.requests_created": "Service requests opened.",
  "staff.analytics.tile.requests_acknowledged": "Requests acknowledged",
  "staff.analytics.hint.requests_acknowledged":
    "Service requests a staff member acknowledged.",
  "staff.analytics.tile.ack_median_seconds": "Time to acknowledge",
  "staff.analytics.hint.ack_median_seconds":
    "Half of the acknowledged requests were acknowledged within this time.",
  "staff.analytics.tile.knowledge_gaps_opened": "Gaps opened",
  "staff.analytics.hint.knowledge_gaps_opened":
    "Unanswered questions added to the content queue.",
  "staff.analytics.tile.knowledge_gaps_closed": "Gaps closed",
  "staff.analytics.hint.knowledge_gaps_closed": "Content gaps the team closed.",
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
  // S09-05 — the escalation email, composed from blocks rather than one template
  // per case. Stage x fallback x "did the guest leave a message" is eight
  // permutations; blocks keep one copy of each fact and let the composer decide
  // which blocks apply. The button-tap path ("Talk to a person") has no guest
  // message at all, so a body that assumed one would print an empty quote.
  //
  // §7 of the charter fixes the subject to the request id plus the property and
  // "no PII beyond that": a subject is stored on the outbox row, is indexed by a
  // third party's mail infrastructure, is legible on a locked phone's banner, and
  // outlives the request. The guest's own words belong in the body, which goes only
  // to people who could already open this conversation in the console.
  "email.request.new.subject": "New guest request at {property} ({requestId})",
  "email.request.acknowledged.subject": "Request acknowledged at {property} ({requestId})",
  "email.request.new.intro": "A guest asked for a person at {property}.",
  "email.request.acknowledged.intro":
    "{actorName} acknowledged request {requestId} at {property}.",
  "email.request.facts": "Request: {requestId}\nType: {topic}",
  "email.request.conversation": "Conversation: {conversationId}",
  // 0001 sets service_requests.conversation_id to NULL when the conversation is
  // deleted, and the request row survives. There is then no console link to give
  // (the detail page is keyed by conversation id), so the email says so instead of
  // printing a link that ends in /inbox/ and resolves to nothing.
  "email.request.no_conversation":
    "This request's conversation is no longer available, so there is no link to open.",
  "email.request.quote": "What the guest wrote:\n{message}",
  // Printed instead of the quote when the mail goes to the deployment-wide
  // fallback because the property configured no contacts of its own. That address
  // is operator level, not scoped to this property, so it gets the pointer and not
  // the content: forwarding one property's guest conversation to an address outside
  // that property's access boundary would be a disclosure, and "nobody was
  // configured, go look" is still the entire point of the notification.
  "email.request.redacted_notice":
    "This property has no escalation email configured, so this went to the deployment fallback. The guest's message is not included here, because this address is not scoped to that property.",
  "email.request.open": "Open it in the console:\n{url}",
  // The acknowledging colleague's display name is not readable from a worker:
  // 0004's `users.staff_select` authorises your own row only, and widening that is
  // an S02 security decision, not something an email composer should do quietly.
  // So the sentence names the role; the console names the person.
  "email.request.actor_team": "A member of our team",
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
  // S11-03 — el huésped pegó algo que parece un número de tarjeta. El turno se
  // rechaza antes de guardarse o registrarse; esta frase es todo lo que ve.
  "guest.chat.card_refused":
    "Ese mensaje parece contener un número de tarjeta, así que no lo enviamos ni lo guardamos. Escriba su pregunta otra vez sin los datos de la tarjeta — nunca comparta números de tarjeta en el chat.",
  "guest.idontknow":
    "No quiero adivinar en esa — le pedí a recepción que le responda directamente.",
  "guest.request_ack":
    "Ya lo pasé a nuestro equipo. Una persona le responderá aquí y verá su respuesta en este chat.",
  "staff.common.brand": "Consola del personal",
  "staff.inbox.title": "Bandeja",
  "staff.inbox.message_redacted":
    "El texto de este mensaje se eliminó al cumplirse el plazo de conservación de la propiedad. La conversación y sus conteos se conservan.",
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
  "staff.flag.button": "Incorrecto o desactualizado",
  "staff.flag.hint": "Un clic. Agregue una nota solo si la tiene.",
  "staff.flag.flagged": "Marcado por {count} personas",
  "staff.flag.flagged_one": "Marcado por 1 persona",
  "staff.flag.flagged_by_you": "Usted lo marcó",
  "staff.flag.note_placeholder": "¿Qué está mal? (opcional)",
  "staff.flag.your_note": "Su nota",
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
  "staff.gaps.nav": "Vacíos",
  "staff.gaps.title": "Vacíos de conocimiento",
  "staff.gaps.intro":
    "Lo que los huéspedes preguntaron y el asistente no pudo responder. Cierre uno cuando el contenido ya exista.",
  "staff.gaps.median": "Tiempo mediano abierto",
  "staff.gaps.median_days": "{days} días",
  "staff.gaps.median_none": "Nada abierto",
  "staff.gaps.target": "Objetivo: 7 días o menos",
  "staff.gaps.open_count": "{count} abiertos",
  "staff.gaps.hits": "Preguntado {count} veces",
  "staff.gaps.hits_one": "Preguntado una vez",
  "staff.gaps.age_minutes": "abierto hace {count} min",
  "staff.gaps.age_hours": "abierto hace {count} h",
  "staff.gaps.age_days": "abierto hace {count} d",
  "staff.gaps.close": "Cerrar",
  "staff.gaps.close_hint": "Indica que el contenido ya responde esto. Si vuelve a preguntarse, se reabre.",
  "staff.gaps.conversation": "Ver la conversación",
  "staff.gaps.empty": "Nada sin responder.",
  "staff.gaps.load_more": "Cargar más",
  "staff.gaps.error": "No se pudo cargar. Inténtelo de nuevo.",
  "staff.gaps.forbidden": "Su rol no puede leer los vacíos.",
  "staff.gaps.problem_invalid": "Esa solicitud no era válida.",
  "staff.gaps.problem_forbidden": "Su rol no puede cerrar un vacío.",
  "staff.gaps.problem_missing": "Ese vacío cambió o ya no existe.",
  "staff.gaps.problem_conflict": "Alguien más llegó primero. Recargue e intente de nuevo.",
  "staff.gaps.problem_error": "Eso no funcionó. Inténtelo de nuevo.",
  "staff.analytics.nav": "Analítica",
  "staff.analytics.title": "Números del día",
  "staff.analytics.intro":
    "Una fila por día y por métrica, calculada con los eventos del propio producto. Cada tarjeta muestra la consulta que la produjo.",
  "staff.analytics.from": "Desde",
  "staff.analytics.to": "Hasta",
  "staff.analytics.show": "Mostrar",
  "staff.analytics.show_query": "Ver la consulta",
  "staff.analytics.metric": "Métrica",
  "staff.analytics.stored": "Valor guardado",
  "staff.analytics.no_data": "Sin datos para este día",
  "staff.analytics.empty": "Todavía no hay cifras calculadas para estos días.",
  "staff.analytics.computed": "Último cálculo {at}",
  "staff.analytics.timezone": "Los días se leen en {zone}.",
  "staff.analytics.recent": "Días recientes",
  "staff.analytics.error": "No se pudieron cargar los números. Inténtelo de nuevo.",
  "staff.analytics.forbidden": "Su rol no puede leer la analítica.",
  "staff.analytics.problem_invalid": "Ese rango de fechas no es válido.",
  "staff.analytics.tile.conversations_started": "Conversaciones",
  "staff.analytics.hint.conversations_started": "Conversaciones abiertas por un huésped.",
  "staff.analytics.tile.messages_received": "Mensajes de huéspedes",
  "staff.analytics.hint.messages_received": "Mensajes que enviaron los huéspedes.",
  "staff.analytics.tile.ai_answers_sent": "Respuestas de la IA",
  "staff.analytics.hint.ai_answers_sent": "Respuestas que el asistente envió por su cuenta.",
  "staff.analytics.tile.escalations": "Pasadas a una persona",
  "staff.analytics.hint.escalations": "Respuestas que se entregaron a una persona.",
  "staff.analytics.tile.no_answers": "Sin respuesta",
  "staff.analytics.hint.no_answers":
    "Preguntas que el asistente no pudo responder con los artículos.",
  "staff.analytics.tile.containment": "Contención",
  "staff.analytics.hint.containment":
    "Proporción de conversaciones que nunca necesitaron un mensaje del personal.",
  "staff.analytics.tile.first_response_p95_seconds": "Primera respuesta p95",
  "staff.analytics.hint.first_response_p95_seconds":
    "El 95% de los huéspedes recibió respuesta dentro de este tiempo.",
  "staff.analytics.tile.requests_created": "Solicitudes",
  "staff.analytics.hint.requests_created": "Solicitudes de servicio abiertas.",
  "staff.analytics.tile.requests_acknowledged": "Solicitudes confirmadas",
  "staff.analytics.hint.requests_acknowledged":
    "Solicitudes de servicio que confirmó un miembro del personal.",
  "staff.analytics.tile.ack_median_seconds": "Tiempo de confirmación",
  "staff.analytics.hint.ack_median_seconds":
    "La mitad de las solicitudes confirmadas se atendió dentro de este tiempo.",
  "staff.analytics.tile.knowledge_gaps_opened": "Vacíos abiertos",
  "staff.analytics.hint.knowledge_gaps_opened":
    "Preguntas sin respuesta añadidas a la cola de contenido.",
  "staff.analytics.tile.knowledge_gaps_closed": "Vacíos cerrados",
  "staff.analytics.hint.knowledge_gaps_closed": "Vacíos de contenido que cerró el equipo.",
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
  "email.request.new.subject": "Nueva solicitud de huésped en {property} ({requestId})",
  "email.request.acknowledged.subject": "Solicitud confirmada en {property} ({requestId})",
  "email.request.new.intro": "Un huésped pidió hablar con una persona en {property}.",
  "email.request.acknowledged.intro":
    "{actorName} confirmó la solicitud {requestId} en {property}.",
  "email.request.facts": "Solicitud: {requestId}\nTipo: {topic}",
  "email.request.conversation": "Conversación: {conversationId}",
  "email.request.no_conversation":
    "La conversación de esta solicitud ya no está disponible, así que no hay un enlace para abrir.",
  "email.request.quote": "Lo que escribió el huésped:\n{message}",
  "email.request.redacted_notice":
    "Esta propiedad no tiene configurado un correo de escalamiento, así que esto llegó al destinatario de respaldo del despliegue. El mensaje del huésped no se incluye aquí, porque esta dirección no pertenece a esa propiedad.",
  "email.request.open": "Ábrela en la consola:\n{url}",
  "email.request.actor_team": "Un miembro de nuestro equipo",
};

// Index with a readonly lookup; unknown ids are a type error, not an
// undefined at runtime.
const catalog: Record<Lang, Readonly<Record<StringId, string>>> = { en, es };

export function t(id: StringId, lang: Lang = "es"): string {
  return catalog[lang][id];
}
