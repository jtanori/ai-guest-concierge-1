---
id: S02-02
title: Property settings
sprint: S02
epic: S02 — Identity, settings, audit
track: Foundation
estimate_days: 1.0
priority: P0
depends_on: [S02-01]
labels: [sprint:S02, track:foundation, prio:P0]
milestone: S02 — Identity, settings, audit
---

# S02-02 — Property settings

## 1. Why

The backlog AC is "AI policy layer reads settings, does not hardcode". The plan
(§3 "Four operating modes, per property", §5 retention, backlog description)
fixes the field list: languages, tone, hours, escalation contacts, enabled
topics, AI mode, spend caps. Today `properties` already carries `ai_mode`
(`auto | draft | human_only | after_hours`), `languages text[]` and an empty
`settings jsonb` (0001) — but nothing validates what goes into `settings`,
nothing reads it, and no module exists that the future AI layer can call
instead of hardcoding a language list, hours or caps.

## 2. Goal

`settings` becomes a validated, typed contract with safe defaults; a pure
policy module answers the questions the AI layer will ask (is this topic
enabled, is it after hours, where does an escalation go, what is the cap); and
a tenant-scoped store reads/writes it under RLS. No HTTP endpoint yet — the
staff API and UI arrive in S04+; this item ships the contract they consume.

## 3. Acceptance criteria

**Backlog AC (verbatim):** AI policy layer reads settings, does not hardcode.

- **AC-1** Every property resolves to a complete, typed settings object:
  stored JSON when valid, `DEFAULT_SETTINGS` when the column is the legacy
  `'{}'` sentinel. A newly inserted property gets the full defaults from the
  column default.
- **AC-2** Invalid settings are rejected twice: `parsePropertySettings` throws
  `SettingsValidationError` naming the path, and a direct `UPDATE` bypassing
  the app fails the DB CHECK `properties_settings_valid`.
- **AC-3** Policy decisions are pure functions of `(settings, ai_mode, now,
  time_zone)`. Tests prove that changing settings changes the decision — no
  constant hours, topics, tone or caps live outside this module.
- **AC-4** Read/write are tenant-scoped: a property-A context cannot read or
  update property B settings; writes land only for the addressed
  `(org_id, property_id)`.
- **AC-5** `ai_mode = 'after_hours'` requires at least one open day in
  `business_hours`; an all-closed week is refused at parse time and by CHECK.
- **AC-6** `languages` is a non-empty subset of the supported catalogs
  (`es`, `en`) — enforced by column CHECK and parser.

## 4. Scope

**In:** migration `0006_property_settings.sql`; `src/settings/schema.ts`,
`src/settings/policy.ts`, `src/settings/store.ts`; unit tests; one db suite
(`tests/db/settings.db.test.ts`).

**Out:** HTTP routes/UI (S04); audit rows for settings changes (S02-03 wires
the write — see §9); spend-cap enforcement and degradation (S07/S11); AI prompt
construction (S05/S06); per-org settings inheritance (no such table yet);
overnight business hours (open > close) — refused in v1, see §9.

## 5. Design

### 5.1 Settings shape v1 (closed key set)

```jsonc
{
  "tone": "warm_professional",            // warm_professional | concise | formal
  "business_hours": [                     // exactly 7 entries, day 0=Sunday..6=Saturday
    { "day": 0, "closed": false, "open": "08:00", "close": "22:00" },
    { "day": 1, "closed": false, "open": "08:00", "close": "22:00" },
    { "day": 2, "closed": false, "open": "08:00", "close": "22:00" },
    { "day": 3, "closed": false, "open": "08:00", "close": "22:00" },
    { "day": 4, "closed": false, "open": "08:00", "close": "22:00" },
    { "day": 5, "closed": false, "open": "08:00", "close": "22:00" },
    { "day": 6, "closed": false, "open": "08:00", "close": "22:00" }
  ],
  "escalation": { "contacts": [] },       // [{ name, channel: "in_app"|"email", value }]
  "enabled_topics": [],                   // topic_key exact matches; empty = escalate everything
  "spend_cap": { "daily_usd": 10, "per_conversation_usd": 0.5 },
  "retention_days": 90                    // integer 1..3650, plan §5 default 90
}
```

Rules: times `HH:MM` 24h with `open < close`; closed days must not carry
`open`/`close`; days unique and sorted; `enabled_topics` non-empty strings;
contacts require non-empty `name`/`value`; spend caps finite numbers `> 0`;
unknown keys rejected (closed set — forward-compatible changes need a
migration).

`'{}'` (legacy/unset) is the **only** partial value accepted; it means "use
defaults". Any other non-default value must be complete. `DEFAULT_SETTINGS` is
exported and must be structurally equal to the DB column default after
parsing.

### 5.2 Migration `0006_property_settings.sql`

- `CREATE FUNCTION property_settings_valid(settings jsonb, ai_mode text) RETURNS boolean IMMUTABLE`
  (plpgsql, no table access) implementing §5.1: `'{}'` → true; otherwise
  complete keys, types, tone enum, time format/order, 7 unique sorted days,
  contacts, topics, caps, retention, and "after_hours needs ≥1 open day".
- `ALTER TABLE properties ADD CONSTRAINT properties_settings_valid CHECK (property_settings_valid(settings, ai_mode))`.
- `ALTER TABLE properties ALTER COLUMN settings SET DEFAULT '<DEFAULT_SETTINGS>'::jsonb`
  — new rows get full defaults; **no backfill UPDATE** (tenant tables are
  `FORCE ROW LEVEL SECURITY`; a migration-time UPDATE would be filtered
  without GUCs. Legacy `'{}'` rows stay valid and parse to defaults).
- `ALTER TABLE properties ADD CONSTRAINT properties_languages_supported CHECK (cardinality(languages) > 0 AND languages <@ ARRAY['es','en']::text[])`.
- `COMMENT ON COLUMN properties.settings` documents the contract and the `'{}'`
  sentinel.
- No new grants: `concierge_app` already has SELECT/UPDATE on `properties`.

### 5.3 `src/settings/schema.ts`

```ts
export const TONES = ["warm_professional", "concise", "formal"] as const;
export const SETTINGS_KEYS = ["tone","business_hours","escalation","enabled_topics","spend_cap","retention_days"] as const;
export const DEFAULT_SETTINGS: PropertySettings;
export class SettingsValidationError extends Error { path: string }
export function parsePropertySettings(value: unknown): PropertySettings; // {} → defaults
export function mergeSettings(current: PropertySettings, patch: Partial<PropertySettings>): PropertySettings; // top-level replace
```

Hand-rolled validation (no new dependency), error paths like
`business_hours[3].open`.

### 5.4 `src/settings/policy.ts` (pure; the "does not hardcode" surface)

```ts
export function isTopicEnabled(settings, topicKey): boolean;            // exact match; [] → false
export function localMinutes(at: Date, timeZone: string): number;       // Intl-based, DST-correct
export function isAfterHours(settings, at: Date, timeZone: string): boolean; // closed day or outside window
export function escalationDecision(settings, input: {
  aiMode: "auto"|"draft"|"human_only"|"after_hours";
  topicKey: string; at: Date; timeZone: string;
}): { escalate: boolean; reason: "topic_disabled"|"after_hours"|"mode_human_only"|"mode_draft"|null;
      contacts: EscalationContact[] };
export function spendCaps(settings): { dailyUsd: number; perConversationUsd: number };
```

Decision table: `human_only` and `draft` always escalate; `after_hours`
escalates outside business hours; `auto` escalates only for disabled topics.
Contacts are returned with every escalation (empty array = queue only).

### 5.5 `src/settings/store.ts`

```ts
export interface PropertyContext { orgId: string; propertyId: string }
export async function loadPropertySettings(client: pg.Client, ctx: PropertyContext): Promise<PropertySettings>;
export async function savePropertySettings(client, ctx, patch: Partial<PropertySettings>):
  Promise<{ settings: PropertySettings; changed: (keyof PropertySettings)[] }>;
```

Both assume the tenant GUCs are set (`withTenant` / `withStaffSession`); RLS
does the scoping. `save` merges over the loaded value, parses the result, then
`UPDATE properties SET settings = $1 WHERE org_id = $2 AND property_id = $3`
and throws `PropertyNotFoundError` when `rowCount !== 1`. `changed` lists
top-level keys whose value differs (S02-03 turns this into the audit detail).
No role checks here — routes use `guard.requireRole("settings", …)`.

## 6. Tenancy and security

- Reads/writes rely on the existing `tenant` policy on `properties`
  (`FORCE ROW LEVEL SECURITY`); the store never builds SQL with tenant IDs
  beyond the WHERE guard.
- `settings` contains no secrets: spend caps are policy numbers, contacts are
  staff contact values. No tokens/credentials in this shape.
- Surface matrix (S02-01): settings read = owner/manager/observer, write =
  owner/manager. Store functions do not bypass that; routes enforce it.
- The DB CHECK is the backstop against a compromised/buggy write path, not a
  substitute for the parser.

## 7. Test plan

Unit — `tests/settings/schema.test.ts`:
- defaults parse; `{}` parses to defaults; complete custom object round-trips.
- each rejection: unknown key, missing key, bad tone, 6 days, duplicate day,
  closed day with times, `open >= close`, bad time format, empty contact name,
  zero/negative cap, retention 0/3651, non-string topic.
- `mergeSettings` replaces top-level keys and keeps siblings.
- `DEFAULT_SETTINGS` parses to itself (idempotent).

Unit — `tests/settings/policy.test.ts`:
- `isAfterHours` at 07:59/08:00/21:59/22:00 in `America/Mexico_City` and a DST
  zone (`America/New_York`) across a spring-forward boundary.
- closed day → after hours all day.
- decision table for all four modes; disabled topic escalates under `auto`;
  empty `enabled_topics` escalates everything; contacts returned.
- changing `tone`/hours/topics changes outputs (no module-level constants).

DB — `tests/db/settings.db.test.ts`:
- new property (inserted under tenant GUCs) has settings equal to
  `DEFAULT_SETTINGS` (column default).
- legacy `'{}'` loads as defaults.
- `savePropertySettings` persists and returns `changed`; re-read matches.
- direct `UPDATE properties SET settings = '{"tone":"shouty"}'` fails with
  constraint `properties_settings_valid`; `ai_mode='after_hours'` with an
  all-closed week fails the same constraint; `languages = '{fr}'` fails
  `properties_languages_supported`.
- property-A context: `load` for B throws/returns not-found; `save` for B
  affects 0 rows (`PropertyNotFoundError`).
- migrating a scratch DB applies 0006 (existing schema test list updated).

## 8. Evidence

```text
$ npm run db:migrate -- --url .../concierge_local      # 6 applied (0006 lands)
$ npm run db:test                                      # all db suites pass
$ npm test                                             # unit suites incl. settings
$ npm run typecheck && npm run lint && npm run build   # clean
```

Runbook entry quotes the new counts and the CHECK constraint names.

## 9. Risks and open questions

- **Spend-cap defaults are placeholders** (`10` / `0.50` USD). Needs a founder
  number before S07 enforces caps. Default accepted now; changing later is a
  data migration, not a schema change.
- **Tone enum** is a product choice (`warm_professional|concise|formal`). If
  brand wants different names, decide before S05 prompts land.
- **Overnight hours** (e.g. bar 18:00–02:00) are refused in v1. If a pilot
  property needs them, extend the schema with `close_next_day` in a later
  migration rather than overloading `close < open`.
- **Audit**: settings writes are consequential. S02-03 adds the audit row in
  the same transaction; S02-02 ships the `changed` list it needs. No audit is
  written until S02-03 lands — sequenced in the same sprint.
- **Brand/org-level defaults**: settings are per property only; org-level
  defaults have no table yet and are out of scope.

## 10. Definition of done

- [ ] `0006` applies cleanly to a fresh and an existing database; checksum
      guard happy.
- [ ] Parser, policy and store merged; no new runtime dependency.
- [ ] Unit + db tests above pass; db-test CI green; suite counts updated.
- [ ] Runbook S02-02 entry with verbatim AC, decisions, evidence numbers.
- [ ] Workbook status tick via the workbook PR pattern after merge.
- [ ] Review threads resolved; out-of-scope list unchanged or explicitly
      amended in the PR.
