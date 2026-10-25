/**
 * S02-02 - property settings contract.
 *
 * A closed, typed shape with safe defaults. `{}` is the legacy/unset sentinel
 * and means "use defaults"; any other value must be complete. The DB CHECK
 * (db/migrations/0006_property_settings.sql) mirrors these rules so a write
 * that bypasses this parser still fails; this parser is the one that gives the
 * caller a path-aware error.
 */

export const TONES = ["warm_professional", "concise", "formal"] as const;
export type Tone = (typeof TONES)[number];

export const ESCALATION_CHANNELS = ["in_app", "email"] as const;
export type EscalationChannel = (typeof ESCALATION_CHANNELS)[number];

export const SETTINGS_KEYS = [
  "tone",
  "business_hours",
  "escalation",
  "enabled_topics",
  "spend_cap",
  "retention_days",
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export type BusinessDay =
  | { day: number; closed: true }
  | { day: number; closed: false; open: string; close: string };

export interface EscalationContact {
  name: string;
  channel: EscalationChannel;
  value: string;
}

export interface PropertySettings {
  tone: Tone;
  business_hours: BusinessDay[];
  escalation: { contacts: EscalationContact[] };
  enabled_topics: string[];
  spend_cap: { daily_usd: number; per_conversation_usd: number };
  retention_days: number;
}

export class SettingsValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "SettingsValidationError";
    this.path = path;
  }
}

const DEFAULT_HOURS: BusinessDay[] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  closed: false,
  open: "08:00",
  close: "22:00",
}));

export const DEFAULT_SETTINGS: PropertySettings = {
  tone: "warm_professional",
  business_hours: DEFAULT_HOURS,
  escalation: { contacts: [] },
  enabled_topics: [],
  spend_cap: { daily_usd: 10, per_conversation_usd: 0.5 },
  retention_days: 90,
};

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function fail(path: string, message: string): never {
  throw new SettingsValidationError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysOf(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = keysOf(value);
  const want = [...expected].sort();
  if (actual.length !== want.length || actual.some((key, i) => key !== want[i])) {
    const prefix = path ? `${path}.` : "";
    const unknown = actual.find((key) => !want.includes(key));
    if (unknown !== undefined) fail(`${prefix}${unknown}`, "unknown key");
    const missing = want.find((key) => !actual.includes(key));
    fail(`${prefix}${missing ?? "?"}`, "is required");
  }
}

function parseTone(value: unknown, path: string): Tone {
  if (typeof value !== "string" || !(TONES as readonly string[]).includes(value)) {
    fail(path, `must be one of ${TONES.join(" | ")}`);
  }
  return value as Tone;
}

function parseTime(value: unknown, path: string): string {
  if (typeof value !== "string" || !TIME_RE.test(value)) {
    fail(path, "must be HH:MM in 24h form");
  }
  return value;
}

function parseHours(value: unknown, path: string): BusinessDay[] {
  if (!Array.isArray(value) || value.length !== 7) {
    fail(path, "must be exactly 7 days");
  }

  const days: BusinessDay[] = [];
  let openDays = 0;
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(entry)) fail(at, "must be an object");
    if (typeof entry["closed"] !== "boolean") fail(`${at}.closed`, "must be a boolean");

    if (entry["closed"]) {
      assertExactKeys(entry, ["day", "closed"], at);
      const day = parseDay(entry["day"], `${at}.day`);
      days.push({ day, closed: true });
      return;
    }

    assertExactKeys(entry, ["day", "closed", "open", "close"], at);
    const day = parseDay(entry["day"], `${at}.day`);
    const open = parseTime(entry["open"], `${at}.open`);
    const close = parseTime(entry["close"], `${at}.close`);
    if (open >= close) fail(`${at}.close`, "must be after open (overnight hours are not supported)");
    openDays += 1;
    days.push({ day, closed: false, open, close });
  });

  days.forEach((entry, index) => {
    if (entry.day !== index) {
      fail(`${path}[${index}].day`, `days must be unique and sorted 0..6 (expected ${index})`);
    }
  });

  if (openDays === 0) {
    fail(path, "at least one day must be open");
  }

  return days;
}

function parseDay(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 6) {
    fail(path, "must be an integer 0..6");
  }
  return value;
}

function parseEscalation(value: unknown, path: string): { contacts: EscalationContact[] } {
  if (!isRecord(value)) fail(path, "must be an object");
  assertExactKeys(value, ["contacts"], path);
  const contacts = value["contacts"];
  if (!Array.isArray(contacts)) fail(`${path}.contacts`, "must be an array");

  return {
    contacts: contacts.map((entry, index) => {
      const at = `${path}.contacts[${index}]`;
      if (!isRecord(entry)) fail(at, "must be an object");
      assertExactKeys(entry, ["name", "channel", "value"], at);

      const name = entry["name"];
      if (typeof name !== "string" || name.length === 0) {
        fail(`${at}.name`, "must be a non-empty string");
      }
      const contactValue = entry["value"];
      if (typeof contactValue !== "string" || contactValue.length === 0) {
        fail(`${at}.value`, "must be a non-empty string");
      }
      const channel = entry["channel"];
      if (
        typeof channel !== "string" ||
        !(ESCALATION_CHANNELS as readonly string[]).includes(channel)
      ) {
        fail(`${at}.channel`, `must be one of ${ESCALATION_CHANNELS.join(" | ")}`);
      }
      return { name, channel: channel as EscalationChannel, value: contactValue };
    }),
  };
}

function parseTopics(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      fail(`${path}[${index}]`, "must be a non-empty string");
    }
    return entry;
  });
}

function parseSpendCap(value: unknown, path: string): {
  daily_usd: number;
  per_conversation_usd: number;
} {
  if (!isRecord(value)) fail(path, "must be an object");
  assertExactKeys(value, ["daily_usd", "per_conversation_usd"], path);

  const parseCap = (entry: unknown, at: string): number => {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) {
      fail(at, "must be a finite number greater than 0");
    }
    return entry;
  };

  return {
    daily_usd: parseCap(value["daily_usd"], `${path}.daily_usd`),
    per_conversation_usd: parseCap(value["per_conversation_usd"], `${path}.per_conversation_usd`),
  };
}

function parseRetention(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3650) {
    fail(path, "must be an integer 1..3650");
  }
  return value;
}

/**
 * Parses stored JSON into a complete settings object. `{}` returns a fresh
 * copy of DEFAULT_SETTINGS; every other value must be complete.
 */
export function parsePropertySettings(value: unknown): PropertySettings {
  if (!isRecord(value)) fail("", "settings must be an object");
  if (Object.keys(value).length === 0) return structuredClone(DEFAULT_SETTINGS);

  assertExactKeys(value, SETTINGS_KEYS, "");

  return {
    tone: parseTone(value["tone"], "tone"),
    business_hours: parseHours(value["business_hours"], "business_hours"),
    escalation: parseEscalation(value["escalation"], "escalation"),
    enabled_topics: parseTopics(value["enabled_topics"], "enabled_topics"),
    spend_cap: parseSpendCap(value["spend_cap"], "spend_cap"),
    retention_days: parseRetention(value["retention_days"], "retention_days"),
  };
}

/** Top-level replace; validates the merged result so a patch cannot corrupt it. */
export function mergeSettings(
  current: PropertySettings,
  patch: Partial<PropertySettings>,
): PropertySettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return parsePropertySettings(next);
}
