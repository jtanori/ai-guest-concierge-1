export const AUDIT_ACTIONS = [
  "settings.updated",
  "request.acknowledged",
  "request.assigned",
  "request.resolved",
  "request.cancelled",
  // S09-02: closing a knowledge gap is a claim that the content now exists.
  "knowledge_gap.closed",
  // S09-03: calling an answer wrong is attributable, so it is audited.
  "answer.flagged",
  // S09-05: an escalation email is how a request reaches a human who is not
  // looking at the console, so both ends of it are audited. `queued` is the AC-1
  // evidence and survives the outbox row being marked sent; `dead` is the case
  // that must never be quiet — the provider refused, or nobody was configured to
  // receive it, and a guest is waiting on a person who was never told.
  "notification.queued",
  "notification.sent",
  "notification.dead",
  "membership.granted",
  "membership.role_changed",
  "membership.revoked",
  "article.version_published",
  "article.version_created",
  "article.updated",
  "article.archived",
  "article.version_approved",
  "article.version_rejected",
  "fact.created",
  "fact.updated",
  "fact.verified",
  "fact.contradiction_resolved",
  "conversation.takeover",
  "message.sent",
  "support.access",
] as const;

export const ENTITY_TYPES = [
  "property",
  "request",
  "knowledge_gap",
  "ai_run",
  "membership",
  "user",
  "article",
  "article_version",
  "fact",
  "fact_group",
  "conversation",
  "message",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type EntityType = (typeof ENTITY_TYPES)[number];

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);
const ENTITY_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);

export function isAuditAction(value: string): value is AuditAction {
  return ACTION_SET.has(value);
}

export function isEntityType(value: string): value is EntityType {
  return ENTITY_SET.has(value);
}
