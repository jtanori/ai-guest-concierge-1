/**
 * W00-19 — event taxonomy (plan Appendix C, ruling of bundle v1.2.1).
 *
 * One append-only `events` table (D10) is written against this module and
 * nothing else; rollups are SQL over that table. The contract test in
 * taxonomy.test.ts holds this list against the canonical 18 from the plan
 * verbatim — an edit that drifts from the plan fails the build.
 *
 * The 18th event is `staff_message_sent`, and it is load-bearing: containment
 * (the north-star) is conversations with zero staff messages, so staff can
 * reply without a takeover and reply repeatedly.
 */
import type { Lang } from "../i18n/catalog.ts";

/** The canonical list, in Appendix C order. Do not reorder — the contract test pins it. */
export const EVENT_NAMES = [
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

export type EventName = (typeof EVENT_NAMES)[number];

export type Channel = "web" | "whatsapp";

/** Context every event carries — plan Appendix C, the D10 contract. */
export interface EventContext {
  orgId: string;
  propertyId: string;
  conversationId: string;
  channel: Channel;
  language: Lang | null; // null until the message language is detected
  topic: string | null; // null until classified
  createdAt: string; // ISO 8601
}

export interface Event<K extends EventName = EventName> {
  type: K;
  context: {
    org_id: string;
    property_id: string;
    conversation_id: string;
    channel: Channel;
    language: Lang | null;
    topic: string | null;
    created_at: string;
  };
  data: Record<string, unknown> | null;
}

export class EventError extends Error {}

export function isEventName(value: string): value is EventName {
  return (EVENT_NAMES as readonly string[]).includes(value);
}

function requiredField(
  ctx: EventContext,
  field: keyof EventContext,
): string {
  const value = ctx[field];
  if (typeof value === "string") {
    if (!value) throw new EventError(`event context field "${field}" must be non-empty`);
    return value;
  }
  return "";
}

/**
 * Build an event row for the append-only table. Throws rather than emitting
 * a context-less event: an event that cannot be attributed to a conversation
 * is exactly the row a nightly rollup silently drops.
 */
export function createEvent<K extends EventName>(
  type: K,
  context: EventContext,
  data: Record<string, unknown> | null = null,
): Event<K> {
  requiredField(context, "orgId");
  requiredField(context, "propertyId");
  requiredField(context, "conversationId");

  if (!context.createdAt) {
    throw new EventError(`event context field "createdAt" must be non-empty`);
  }
  if (Number.isNaN(Date.parse(context.createdAt))) {
    throw new EventError(`event context field "createdAt" is not ISO 8601`);
  }
  if (context.channel !== "web" && context.channel !== "whatsapp") {
    throw new EventError(`event context field "channel" must be "web" or "whatsapp"`);
  }

  return {
    type,
    context: {
      org_id: context.orgId,
      property_id: context.propertyId,
      conversation_id: context.conversationId,
      channel: context.channel,
      language: context.language,
      topic: context.topic,
      created_at: context.createdAt,
    },
    data,
  };
}
