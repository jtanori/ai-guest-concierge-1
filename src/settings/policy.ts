/**
 * S02-02 - the pure policy surface the AI layer consumes.
 *
 * Nothing here reads a constant hours list, topic list, tone or cap: every
 * answer is a function of the property's settings plus the supplied clock and
 * time zone. That is what "AI policy layer reads settings, does not hardcode"
 * means in code.
 */
import type {
  EscalationContact,
  PropertySettings,
} from "./schema.ts";

export type AiMode = "auto" | "draft" | "human_only" | "after_hours";

export type EscalationReason =
  | "topic_disabled"
  | "after_hours"
  | "mode_human_only"
  | "mode_draft"
  | null;

export interface EscalationInput {
  aiMode: AiMode;
  topicKey: string;
  at: Date;
  timeZone: string;
}

export interface EscalationDecision {
  escalate: boolean;
  reason: EscalationReason;
  contacts: EscalationContact[];
}

/** Exact topic match. An empty list means nothing is explicitly enabled. */
export function isTopicEnabled(settings: PropertySettings, topicKey: string): boolean {
  return settings.enabled_topics.includes(topicKey);
}

/** Minutes since local midnight in `timeZone`, DST-correct via Intl. */
export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return (hour % 24) * 60 + minute;
}

/** Local day of week, 0 = Sunday .. 6 = Saturday. */
function localWeekday(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function toMinutes(value: string): number {
  const [hour, minute] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

/** Closed day, or outside the open/close window. Exactly close is after hours. */
export function isAfterHours(
  settings: PropertySettings,
  at: Date,
  timeZone: string,
): boolean {
  const weekday = localWeekday(at, timeZone);
  const today = settings.business_hours.find((entry) => entry.day === weekday);
  if (!today || today.closed) return true;

  const minutes = localMinutes(at, timeZone);
  return minutes < toMinutes(today.open) || minutes >= toMinutes(today.close);
}

/**
 * Decision table: human_only and draft always escalate; after_hours escalates
 * outside the property's hours; auto escalates only for topics that are not
 * explicitly enabled. Contacts travel with every escalation (empty = queue).
 */
export function escalationDecision(
  settings: PropertySettings,
  input: EscalationInput,
): EscalationDecision {
  const contacts = settings.escalation.contacts;

  if (input.aiMode === "human_only") {
    return { escalate: true, reason: "mode_human_only", contacts };
  }
  if (input.aiMode === "draft") {
    return { escalate: true, reason: "mode_draft", contacts };
  }
  if (input.aiMode === "after_hours" && isAfterHours(settings, input.at, input.timeZone)) {
    return { escalate: true, reason: "after_hours", contacts };
  }
  if (!isTopicEnabled(settings, input.topicKey)) {
    return { escalate: true, reason: "topic_disabled", contacts };
  }
  return { escalate: false, reason: null, contacts: [] };
}

export function spendCaps(settings: PropertySettings): {
  dailyUsd: number;
  perConversationUsd: number;
} {
  return {
    dailyUsd: settings.spend_cap.daily_usd,
    perConversationUsd: settings.spend_cap.per_conversation_usd,
  };
}
