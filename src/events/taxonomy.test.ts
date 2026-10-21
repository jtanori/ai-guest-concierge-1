import { describe, expect, it } from "vitest";
import { createEvent, EVENT_NAMES, EventError, isEventName } from "./taxonomy.ts";

/**
 * The canonical 18, copied verbatim from the plan's Appendix C (bundle
 * v1.2.1). Copied on purpose: if this module and the plan ever drift, the
 * build fails here. This is the "no dashboard before this exists" guarantee.
 */
const PLAN_APPENDIX_C_ORDER = [
  "conversation_started",
  "message_received",
  "ai_run_completed",
  "ai_answer_sent",
  "ai_escalated",
  "no_answer_emitted",
  "human_takeover",
  "staff_message_sent",
  "request_created",
  "request_acknowledged",
  "request_assigned",
  "request_resolved",
  "answer_flagged_wrong",
  "knowledge_gap_created",
  "knowledge_gap_closed",
  "booking_link_clicked",
  "outbound_webhook_delivered",
  "message_failed",
] as const;

const CTX = {
  orgId: "org-1",
  propertyId: "prop-1",
  conversationId: "conv-1",
  channel: "web" as const,
  language: "es" as const,
  topic: "pool.hours",
  createdAt: "2026-10-21T12:00:00.000Z",
};

describe("W00-19 — the taxonomy is the plan's 18 events, in order", () => {
  it("matches Appendix C exactly — count, names, order", () => {
    expect(EVENT_NAMES).toHaveLength(PLAN_APPENDIX_C_ORDER.length);
    expect([...EVENT_NAMES]).toEqual([...PLAN_APPENDIX_C_ORDER]);
  });

  it("includes staff_message_sent — containment is uncomputable without it", () => {
    expect(EVENT_NAMES).toContain("staff_message_sent");
    expect(EVENT_NAMES).not.toContain("answer_overridden"); // explicitly not added (v1.2.1)
  });

  it("all names are snake_case and unique", () => {
    const names = [...EVENT_NAMES];
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => /^[a-z][a-z0-9_]*$/.test(n))).toBe(true);
  });

  it("isEventName narrows a string", () => {
    expect(isEventName("request_created")).toBe(true);
    expect(isEventName("made_up_event")).toBe(false);
    expect(isEventName("request_created") && true).toBe(true);
  });
});

describe("event factory — the D10 contract", () => {
  it("stamps the seven context fields (org_id, property_id, conversation_id, channel, language, topic, created_at)", () => {
    const event = createEvent("message_received", CTX, { text: "¿a qué hora?" });
    expect(event.context).toEqual({
      org_id: "org-1",
      property_id: "prop-1",
      conversation_id: "conv-1",
      channel: "web",
      language: "es",
      topic: "pool.hours",
      created_at: "2026-10-21T12:00:00.000Z",
    });
    expect(event.data).toEqual({ text: "¿a qué hora?" });
  });

  it("refuses a context with an empty tenant field", () => {
    expect(() =>
      createEvent("conversation_started", { ...CTX, orgId: "" }),
    ).toThrow(EventError);
    expect(() =>
      createEvent("message_received", { ...CTX, conversationId: "" }),
    ).toThrow(EventError);
  });

  it("refuses an unparseable created_at", () => {
    expect(() =>
      createEvent("ai_run_completed", { ...CTX, createdAt: "yesterday" }),
    ).toThrow(EventError);
  });

  it("refuses an unknown channel", () => {
    expect(() =>
      createEvent("booking_link_clicked", { ...CTX, channel: "sms" as never }),
    ).toThrow(/channel/);
  });

  it("language and topic may be null before detection/classification", () => {
    const event = createEvent("conversation_started", {
      ...CTX,
      language: null,
      topic: null,
    });
    expect(event.context.language).toBeNull();
    expect(event.context.topic).toBeNull();
  });
});
