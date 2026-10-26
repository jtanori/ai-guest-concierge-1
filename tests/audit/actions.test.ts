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
