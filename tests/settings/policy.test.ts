/**
 * S02-02 - pure policy decisions. Every expected value is derived from the
 * settings object and the supplied clock; no module-level hours/topic/cap
 * constants are allowed to leak into the result.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  type BusinessDay,
  type PropertySettings,
} from "../../src/settings/schema.ts";
import {
  escalationDecision,
  isAfterHours,
  isTopicEnabled,
  localMinutes,
  spendCaps,
} from "../../src/settings/policy.ts";

const MEXICO = "America/Mexico_City";

function settings(): PropertySettings {
  return structuredClone(DEFAULT_SETTINGS);
}

function withHours(hours: BusinessDay[]): PropertySettings {
  const value = settings();
  value.business_hours = hours;
  return value;
}

function closedDay(day: number): BusinessDay {
  return { day, closed: true };
}

describe("property settings policy", () => {
  it("isTopicEnabled is an exact match and [] enables nothing", () => {
    const value = settings();
    expect(isTopicEnabled(value, "wifi")).toBe(false);
    value.enabled_topics = ["wifi", "parking"];
    expect(isTopicEnabled(value, "wifi")).toBe(true);
    expect(isTopicEnabled(value, "WIFI")).toBe(false);
  });

  it("computes local minutes and survives the spring-forward offset change", () => {
    expect(localMinutes(new Date("2026-10-24T14:00:00Z"), MEXICO)).toBe(8 * 60);
    // 2026-03-08 America/New_York: 06:30Z is 01:30 EST, 07:30Z is 03:30 EDT.
    expect(localMinutes(new Date("2026-03-08T06:30:00Z"), "America/New_York")).toBe(90);
    expect(localMinutes(new Date("2026-03-08T07:30:00Z"), "America/New_York")).toBe(210);
  });

  it("is after hours before open, at close, and all day on a closed day", () => {
    const value = settings();
    expect(isAfterHours(value, new Date("2026-10-24T13:59:00Z"), MEXICO)).toBe(true);
    expect(isAfterHours(value, new Date("2026-10-24T14:00:00Z"), MEXICO)).toBe(false);
    expect(isAfterHours(value, new Date("2026-10-25T03:59:00Z"), MEXICO)).toBe(false);
    expect(isAfterHours(value, new Date("2026-10-25T04:00:00Z"), MEXICO)).toBe(true);

    const saturdayClosed = withHours(
      value.business_hours.map((entry) => (entry.day === 6 ? closedDay(6) : entry)),
    );
    expect(isAfterHours(saturdayClosed, new Date("2026-10-24T18:00:00Z"), MEXICO)).toBe(true);
  });

  it("evaluates after-hours on the wall clock across a DST change (S08-04)", () => {
    // 09:00-17:00 every day, New York. The offset moves -5 → -4 on 2026-03-08, so
    // 13:30Z is 08:30 (closed) the day before and 09:30 (open) on the day itself.
    // A server that computed "after hours" from UTC, or that cached the offset at
    // boot, gets one of these two wrong.
    const daily = Array.from({ length: 7 }, (_unused, day) => ({
      day,
      closed: false,
      open: "09:00",
      close: "17:00",
    }));
    const ny = withHours(daily);

    expect(isAfterHours(ny, new Date("2026-03-07T13:30:00Z"), "America/New_York")).toBe(true);
    expect(isAfterHours(ny, new Date("2026-03-08T13:30:00Z"), "America/New_York")).toBe(false);
    expect(isAfterHours(ny, new Date("2026-03-09T13:30:00Z"), "America/New_York")).toBe(false);
    // Fall back (2026-11-01): the same UTC hour is 08:30 again, so closed again.
    expect(isAfterHours(ny, new Date("2026-11-01T13:30:00Z"), "America/New_York")).toBe(true);
  });

  it("follows the four-mode decision table", () => {
    const value = settings();
    value.enabled_topics = ["wifi"];
    const at = new Date("2026-10-24T14:00:00Z"); // 08:00 local, Saturday

    expect(
      escalationDecision(value, { aiMode: "human_only", topicKey: "wifi", at, timeZone: MEXICO }),
    ).toMatchObject({ escalate: true, reason: "mode_human_only" });

    expect(
      escalationDecision(value, { aiMode: "draft", topicKey: "wifi", at, timeZone: MEXICO }),
    ).toMatchObject({ escalate: true, reason: "mode_draft" });

    expect(
      escalationDecision(value, { aiMode: "after_hours", topicKey: "wifi", at, timeZone: MEXICO }),
    ).toMatchObject({ escalate: false, reason: null });

    expect(
      escalationDecision(value, {
        aiMode: "after_hours",
        topicKey: "wifi",
        at: new Date("2026-10-24T13:59:00Z"),
        timeZone: MEXICO,
      }),
    ).toMatchObject({ escalate: true, reason: "after_hours" });

    expect(
      escalationDecision(value, { aiMode: "auto", topicKey: "wifi", at, timeZone: MEXICO }),
    ).toMatchObject({ escalate: false, reason: null });

    expect(
      escalationDecision(value, { aiMode: "auto", topicKey: "spa", at, timeZone: MEXICO }),
    ).toMatchObject({ escalate: true, reason: "topic_disabled" });
  });

  it("escalates every topic under auto when the enabled list is empty", () => {
    const value = settings();
    const decision = escalationDecision(value, {
      aiMode: "auto",
      topicKey: "anything",
      at: new Date("2026-10-24T14:00:00Z"),
      timeZone: MEXICO,
    });
    expect(decision).toMatchObject({ escalate: true, reason: "topic_disabled" });
  });

  it("returns contacts with every escalation and none when it does not escalate", () => {
    const value = settings();
    value.enabled_topics = ["wifi"];
    value.escalation.contacts = [
      { name: "Front desk", channel: "in_app", value: "desk" },
      { name: "Manager", channel: "email", value: "gm@example.com" },
    ];
    const at = new Date("2026-10-24T14:00:00Z");

    const escalated = escalationDecision(value, {
      aiMode: "auto",
      topicKey: "spa",
      at,
      timeZone: MEXICO,
    });
    expect(escalated.contacts).toEqual(value.escalation.contacts);

    const answered = escalationDecision(value, {
      aiMode: "auto",
      topicKey: "wifi",
      at,
      timeZone: MEXICO,
    });
    expect(answered.contacts).toEqual([]);
  });

  it("changes decisions when settings change (nothing hardcoded)", () => {
    const at = new Date("2026-10-24T14:00:00Z"); // 08:00 local
    const value = settings();
    value.enabled_topics = ["wifi"];
    expect(
      escalationDecision(value, { aiMode: "auto", topicKey: "wifi", at, timeZone: MEXICO }).escalate,
    ).toBe(false);

    value.enabled_topics = [];
    expect(
      escalationDecision(value, { aiMode: "auto", topicKey: "wifi", at, timeZone: MEXICO }).escalate,
    ).toBe(true);

    const laterOpen = withHours(
      value.business_hours.map((entry) =>
        entry.day === 6 ? { day: 6, closed: false, open: "09:00", close: "22:00" } : entry,
      ),
    );
    expect(isAfterHours(laterOpen, at, MEXICO)).toBe(true);
  });

  it("maps spend caps without inventing values", () => {
    const value = settings();
    value.spend_cap = { daily_usd: 42, per_conversation_usd: 2.5 };
    expect(spendCaps(value)).toEqual({ dailyUsd: 42, perConversationUsd: 2.5 });
  });
});
