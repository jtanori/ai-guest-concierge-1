import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  ENTITY_TYPES,
  isAuditAction,
  isEntityType,
} from "../../src/audit/actions.ts";

describe("audit vocabulary (S02-03)", () => {
  it("keeps the closed action list explicit", () => {
    expect(AUDIT_ACTIONS).toEqual([
      "settings.updated",
      "request.acknowledged",
      "request.assigned",
      "request.resolved",
      "request.cancelled",
      "knowledge_gap.closed",
      "answer.flagged",
      // S09-05: an escalation email is how a request reaches a human who is not
      // looking at the console, so both ends are audited. `queued` is the AC-1
      // evidence and outlives the outbox row being marked sent; `dead` is the case
      // that must never be quiet — the provider refused, or nobody was configured
      // to receive it, and a guest is waiting on a person who was never told.
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
      // S04-01: the review queue's decisions are auditable events
      "article.version_approved",
      "article.version_rejected",
      "fact.created",
      "fact.updated",
      "fact.verified",
      "fact.contradiction_resolved",
      "conversation.takeover",
      "message.sent",
      "support.access",
    ]);
  });

  it("keeps the closed entity list explicit", () => {
    expect(ENTITY_TYPES).toEqual([
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
    ]);
  });

  it("accepts every declared action and rejects free-form strings", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(isAuditAction(action), action).toBe(true);
    }
    for (const value of ["settings.saved", "SETTINGS.UPDATED", "", "settings.updated "]) {
      expect(isAuditAction(value), value).toBe(false);
    }
  });

  it("accepts every declared entity and rejects free-form strings", () => {
    for (const entity of ENTITY_TYPES) {
      expect(isEntityType(entity), entity).toBe(true);
    }
    for (const value of ["propertys", "PROPERTY", "", " article"]) {
      expect(isEntityType(value), value).toBe(false);
    }
  });
});
