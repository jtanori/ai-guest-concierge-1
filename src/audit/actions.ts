export const AUDIT_ACTIONS = [
  "settings.updated",
  "membership.granted",
  "membership.role_changed",
  "membership.revoked",
  "article.version_published",
  "article.version_created",
  "article.updated",
  "article.archived",
  "fact.verified",
  "conversation.takeover",
  "message.sent",
  "support.access",
] as const;

export const ENTITY_TYPES = [
  "property",
  "membership",
  "user",
  "article",
  "article_version",
  "fact",
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
