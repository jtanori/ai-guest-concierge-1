---
id: S03-03
title: property_facts table + UI
sprint: S03
epic: S03 - Knowledge
track: Knowledge
estimate_days: 2.0
priority: P0
depends_on: [S03-01]
labels: [sprint:S03, track:foundation, prio:P0]
milestone: S03 - Knowledge
---

# S03-03 - property_facts table + UI

## 1. Why

Hours and prices are data, not prose. The plan requires deterministic
answers from `property_facts` so the model never generates a pool closing
time or invents a spa price. The table exists in 0001, but it lacks the
plan's verification/effective-date/source-version columns, the fixture's
`unit` and `effective_from` are currently dropped by the seed, and there is
no lookup or contradiction rule.

The backlog AC is "Pool hours answered by lookup, not generation". The
sprint gate G1 also requires **zero unresolved contradictions**, so this
item owns the deterministic lookup and the verify-time contradiction guard;
S04-01 owns the human resolution screen.

## 2. Goal

A tenant-scoped fact service: create/update/list facts, verify them with an
actor, look up only verified facts by exact key, and refuse verification
when another verified fact contradicts it. No browser UI and no LLM in this
item.

## 3. Acceptance criteria

**Backlog AC (verbatim):** Pool hours answered by lookup, not generation.

- **AC-1** `lookupFact` returns the verified fact value for an exact
  `(topic_key, fact_key, language)` and never calls an LLM or an embedding
  provider.
- **AC-2** Unverified facts, and facts with no verified row, return `null`
  (no answer) rather than a guess. The two contradictory pool facts in the
  fixture therefore produce no answer until a human resolves them.
- **AC-3** `verifyFact` requires an actor, sets `verified = true`,
  `verified_by`, `verified_at`, and refuses a different value for the same
  `(topic_key, fact_key, language, effective_from)` that is already verified.
- **AC-4** Facts are tenant-scoped; a foreign fact id or topic is
  indistinguishable from an unknown one. Updating value/unit/effective date/
  language resets verification to false.
- **AC-5** `0009_property_facts.sql` adds `unit`, `effective_from`,
  `source_article_version_id`, `verified_by`, `verified_at` with constraints;
  the demo seed fills the fixture's unit/effective/source-version values.
- **AC-6** Create/update/verify each write an audit row (`fact.created`,
  `fact.updated`, `fact.verified`) in the same transaction; detail never
  includes message/body content.

## 4. Scope

**In:** `db/migrations/0009_property_facts.sql`;
`src/knowledge/facts.ts` (create/update/list/get/verify/lookup/
contradictions); fixture `factKey` + seed update; unit and DB tests.

**Out:** browser UI (S08), semantic/embedding fact retrieval (S05/S06),
seasonal price tables beyond `effective_from`, currency conversion, price
calculation, human contradiction-resolution UI (S04-01), fact archival,
LLM extraction from articles.

## 5. Design

### 5.1 Migration

`0009_property_facts.sql`:

```sql
ALTER TABLE property_facts
  ADD COLUMN unit text NOT NULL DEFAULT 'text',
  ADD COLUMN effective_from date,
  ADD COLUMN source_article_version_id uuid,
  ADD COLUMN verified_by uuid REFERENCES users(user_id),
  ADD COLUMN verified_at timestamptz;

ALTER TABLE property_facts
  ADD CONSTRAINT property_facts_unit_check
    CHECK (unit IN ('text', 'time-of-day', 'hours', 'currency-amount',
                    'duration', 'distance', 'count')),
  ADD CONSTRAINT property_facts_verified_fields
    CHECK (verified = false OR (verified_by IS NOT NULL
                                AND verified_at IS NOT NULL
                                AND effective_from IS NOT NULL))
    NOT VALID,
  ADD CONSTRAINT property_facts_source_version_fk
    FOREIGN KEY (org_id, property_id, source_article_version_id)
    REFERENCES article_versions (org_id, property_id, article_version_id)
    ON DELETE SET NULL (source_article_version_id);

ALTER TABLE property_facts
  DROP CONSTRAINT property_facts_property_id_topic_key_fact_key_language_key;

CREATE UNIQUE INDEX property_facts_verified_key
  ON property_facts (property_id, topic_key, fact_key, language, effective_from)
  WHERE verified;

CREATE INDEX property_facts_lookup
  ON property_facts (property_id, topic_key, fact_key, language,
                     effective_from DESC, created_at DESC)
  WHERE verified;
```

- Existing rows get `unit = 'text'`; the seed updates the demo rows to the
  fixture units.
- `effective_from` is nullable for legacy rows; verified facts must have it.
- `source_article_version_id` is the D5 citation link; `source_id` remains
  for the source document.
- No backfill UPDATE; tenant tables are FORCE RLS. The seed's `ON CONFLICT`
  path fills the new fields.

**Amended in implementation (operator-approved 2026-10-25, PR #32 review
round 1)** — §5.1 as approved could not satisfy §5.2: 0001's
`UNIQUE (property_id, topic_key, fact_key, language)` makes the two pool
rows (which §5.2 says must share the key) impossible, and a *validated*
`property_facts_verified_fields` aborts the migration on any database that
already has a verified row (it has no `effective_from`). Both were resolved
in code and are now recorded here:

- **The 0001 UNIQUE is dropped.** Two rows must coexist while they disagree,
  otherwise there is nothing for a human to resolve and no contradiction
  queue for S04-01. The invariant that replaces it: **at most one *verified*
  row per `(property_id, topic_key, fact_key, language, effective_from)`**,
  enforced by the partial unique index `property_facts_verified_key ...
  WHERE verified`. Unverified duplicates are legal and bounded by the
  review/settle path in S04-01; they are never answerable (AC-2) because
  `lookupFact` hard-filters `verified`.
- **The verified CHECK is `NOT VALID`.** New and updated rows are still
  checked; pre-0009 verified rows survive the migration and are unreachable
  by `lookupFact` (a NULL `effective_from` never satisfies
  `effective_from <= on`), so an operator re-verifies or unverifies them
  rather than the migration dying with a bare `23514`.
- **`property_facts_lookup` is partial on `verified`** and carries both
  `ORDER BY` columns, so the guest path reads only verified rows and can
  satisfy `ORDER BY ... LIMIT 1` from the index while unverified variants
  accumulate underneath.
- **`verified` is defended in the database, not by convention.** 0002 grants
  `concierge_app` full DML on every tenant table, so a raw `UPDATE ... SET
  verified = true` would publish an un-reviewed value (no actor, no
  contradiction check, no audit) — and a raw `UPDATE fact_value` could edit
  a verified fact in place. 0009 reuses 0003's proven pattern:
  1. `property_facts_guard_verification()` (BEFORE INSERT OR UPDATE) drops
     `verified/verified_by/verified_at` whenever the fact's content or
     citation changes (any role, including the owner), refuses any
     `false → true` flip or stamp rewrite unless `current_user` is
     `concierge_fact_verifier`, and keeps unverified rows stamp-free;
  2. `verify_property_fact(fact_id, actor)` is `SECURITY DEFINER` owned by
     that NOLOGIN role; it refuses an actor that is not the session user
     (`app.current_user_id`, set by `withStaffSession`) or not a member of
     the property (0004's `current_membership_role`), then writes the stamp;
  3. `concierge_app` keeps `UPDATE` only on the content/citation columns —
     `verified`, `verified_by`, `verified_at` are not app-writable at all.
  The migration's owner is deliberately not left a member of the verifier
  role, exactly as 0004/0005 require.

### 5.2 Fixture and seed

Add `factKey` to `FixtureFact`:

| fact | topic | factKey | unit |
|---|---|---|---|
| pool website | `pool.hours` | `closing_time` | `time-of-day` |
| pool directory | `pool.hours` | `closing_time` | `time-of-day` |
| spa massage | `spa.services` | `massage_60` | `currency-amount` |
| spa facial | `spa.services` | `facial` | `currency-amount` |
| gym hours | `gym.hours` | `hours` | `hours` |

The seed writes `fact_key = factKey`, `unit`, `effective_from`, and
`source_article_version_id` (not `source_id`) for the five facts. The
`fact_id` values stay stable. `ON CONFLICT (fact_id) DO UPDATE` fills the
new columns on an existing demo DB; counts stay 5. It rewrites only the four
added fields, so a re-seed never resets an operator's `verified` verdict, and
the fixture's `effectiveFrom` (`2026-01-01`) / `sourceArticleVersionId` (the
matching published `article_version`) are what the lookup window and the D5
citation link are read from.

Verified on a simulated pre-0009 demo database (`fact_key` = fixture id,
`unit = 'text'`, no effective date, no source version): one `db:seed` run
upgraded all five rows in place to `closing_time`/`massage_60`/`facial`/
`hours` with their units, `2026-01-01` and non-null source versions, and the
count stayed 5.

The two pool facts share `(topic_key='pool.hours', fact_key='closing_time',
language='es')` and different values, so they are a real contradiction. The
spa facts have different `fact_key`s, so different prices are not a
contradiction.

### 5.3 Service

```ts
export interface FactInput {
  topicKey: string;
  factKey: string;
  value: string;
  unit: FactUnit;                 // closed set above
  language: string;               // BCP-47-ish; 'es' | 'en' | 'fr' allowed
  effectiveFrom: string;          // YYYY-MM-DD
  sourceArticleVersionId?: string | null;
}

export async function createFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  input: FactInput,
): Promise<{ factId: string }>;

export async function updateFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  factId: string,
  input: FactInput,
): Promise<{ factId: string; verifiedReset: boolean }>;

export async function listFacts(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<FactSummary[]>;

export async function getFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  factId: string,
): Promise<FactDetail>;

export async function verifyFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  actor: { userId: string },
  factId: string,
): Promise<{ factId: string }>;

export async function lookupFact(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: { topicKey: string; factKey: string; language: string; on?: string },
): Promise<{ value: string; unit: FactUnit; effectiveFrom: string } | null>;

export async function listContradictions(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<Contradiction[]>;
```

- `lookupFact` selects `verified = true`, exact key/language, and the latest
  `effective_from <= on`. When `on` is omitted it is **today at the property**
  (`properties.time_zone`, resolved in TS by the exported
  `propertyLocalDate()`), not the database session's date — 02:00Z is still
  "yesterday" in a UTC-6 property, and answering from the session date would
  publish tomorrow's hours a few hours early. `CURRENT_DATE` remains only the
  last-resort fallback when the timezone is missing/unparseable. Order by
  `effective_from DESC, created_at DESC`; return the first. It never embeds,
  ranks or generates, and the statement (`FACT_LOOKUP_SQL`) is exported so its
  shape is testable.
- `verifyFact` resolves the actor **first** (`assertSessionActor`: the id must
  equal `app.current_user_id` — set by `withStaffSession` — and the user must
  be a member of this property; otherwise `FactActorError`). The unlocked key
  read is group *discovery* only. The whole key group is then locked
  `ORDER BY fact_id FOR UPDATE` and every value written to the audit row is
  read from that locked result, so a concurrent `updateFact` cannot make the
  trail lie. An already-verified target is a no-op (same stamp, no second
  audit row); another verified row for the same key + effective date is
  `FactContradictionError` with both ids and the conflicting value. The write
  itself goes through `verify_property_fact()`; its refusals map to
  `FactNotFoundError`/`FactActorError`/`FactVerificationError`, and a 23505 is
  the contradiction backstop.
- `updateFact` always resets `verified=false`, `verified_by=NULL`,
  `verified_at=NULL` — enforced by 0009's trigger (the app does not even hold
  the column permission) and reported back as `verifiedReset`. `FactInput.
  sourceArticleVersionId` is tri-state: omitted keeps the existing D5 link,
  `null` clears it, a UUID replaces it.
- `listContradictions` groups by `(topic_key, fact_key, language,
  effective_from)` having `count(distinct fact_value) > 1`, returning the
  values and source version ids. It reports both verified and unverified
  rows so S04-01 can show the queue.
- `createFact` starts unverified and validates that `sourceArticleVersionId`,
  when given, is a version of this tenant.

### 5.4 Validation

- `topicKey`/`factKey`: lowercase dot/underscore segments; non-empty; max
  120 chars.
- `value`: trimmed, 1..500 chars; stored as text (prices keep their
  currency/unit in `value` for v1).
- `unit`: closed set from the CHECK.
- `language`: non-empty 2-8 lowercase letters (fixture uses `fr`, so the
  `es|en` article rule does not apply to facts).
- `effectiveFrom`: real `YYYY-MM-DD` date, not in the future? Seasonal facts
  may be future-dated; allow future.
- `sourceArticleVersionId`: UUID when present; the composite FK enforces the
  tenant.

### 5.5 Audit

Add actions `fact.created` and `fact.updated`; `fact.verified` already exists.
Detail: `{topic_key, fact_key, unit, language, effective_from}` and, for
verify, `{value}`. Never put article body/message content in detail.

## 6. Tenancy and security

- All service functions run inside `withTenant` / `withStaffSession`; RLS
  scopes every row.
- `verified_by` is the resolved session user id, never a request field: every
  fact write goes through `assertSessionActor`, which requires
  `app.current_user_id` to equal the passed actor and the actor to be a
  member of this property, and `verify_property_fact()` re-checks the same
  two facts inside the database.
- `verified`, `verified_by` and `verified_at` are not app-writable columns;
  the guard trigger refuses a raw verification or stamp rewrite for every
  role, and a content/citation edit drops the verification automatically.
- Foreign fact ids/topics return `FactNotFoundError`; no existence leak.
- `lookupFact` is deterministic and side-effect free; it is safe for the
  future guest path because it cannot generate text.
- No public route in this item; S04-01/S08 own authorization and UI.

## 7. Test plan

Unit - `tests/knowledge/facts.test.ts` (17):
- unit/language/date/key validation; invalid dates; closed unit set.
- `lookupFact` query shape has no embedding/LLM call (pure module test), and
  the SQL hard-filters `verified` + exact key + tenant, newest first.
- `propertyLocalDate` at fixed instants (the UTC-6 "still yesterday" case,
  zero-padding, and the null fallback) and `lookupFact` asking the property
  for the date only when `on` is absent.

DB - `tests/db/facts.db.test.ts` (19):
- migration applies 0009; existing unverified rows satisfy constraints.
- 0009 shape from the catalog: the five columns, `unit_check` +
  `source_version_fk`, `property_facts_verified_fields` **NOT VALID**
  (`convalidated = false`), 0001's unique absent, `property_facts_verified_key`
  and the partial `property_facts_lookup` index, the guard trigger, and
  `concierge_app` having `UPDATE` on content columns but not on
  `verified/verified_by/verified_at` while holding `EXECUTE` on
  `verify_property_fact`.
- seed: 5 facts with units/effective dates/source version ids; pool facts
  share `closing_time`; spa keys differ.
- `lookupFact` returns the verified pool value when one is verified; returns
  `null` while both are unverified (the AC's "no guess" case).
- `verifyFact` refuses the contradictory pool value; verifies the other;
  lookup then returns it.
- `verifyFact` requires an actor bound to the session (none, wrong user,
  foreign member) and sets `verified_by/at`.
- **P1 guard:** the app role cannot even name `verified`/`verified_by`
  (42501); an insert arriving `verified = true` is refused by the trigger;
  the table owner cannot flip `verified` or strip a stamp; a content edit by
  either role drops the verification; with the trigger disabled the CHECK
  still fires (23514); and no probe writes an audit row.
- re-verifying is idempotent: same `verified_at`, same `verified_by`, no
  second `fact.verified` row.
- `updateFact` resets verification; lookup returns `null` again. The D5
  citation survives an update that omits `sourceArticleVersionId` and is
  cleared only by an explicit `null`.
- the property's timezone decides "today" at a fixed clock, and an explicit
  `on` still wins.
- the lookup path uses the partial verified index (`EXPLAIN`).
- `listContradictions` finds the pool pair and does not flag the two spa
  prices.
- property-B context cannot read/update property-A facts.
- audit rows exist for create/update/verify; failed audit rolls back.
- a legacy row with no `effective_from` cannot be verified (the CHECK would
  fire).

`tests/db/non-superuser.db.test.ts` also covers 0009: the migration count is
9, `concierge_fact_verifier` is a cluster role the deployed owner is not a
member of and cannot `SET ROLE` into.

## 8. Evidence

```text
$ npm run db:migrate -- --url .../concierge_local      # 9 applied (0009 lands)
$ npm run db:seed  -- --url .../concierge_local        # 5 facts, new fields filled
$ npm run db:seed  -- --url .../concierge_local        # re-seed: still 5, no reset
$ npm run db:test                                      # 126 passed (126), incl. 19 facts
$ npm test                                             # 268 passed (268), incl. 17 facts
$ npm run typecheck && npm run lint && npm run build    # all clean
```

Measured on PostgreSQL 16 + pgvector 0.6.2 + pg_trgm (a real cluster, not a
mocked client), which is what makes the trigger/definer/ACL claims in §5.1
executable rather than argued. Runbook S03-03 records the lookup/no-guess
case, the contradiction refusal, the raw-SQL probes and the counts.

## 9. Risks and open questions

- **No UI.** API/service-first per the 2026-10-24 decision; S08 owns the facts
  screen. S02-06 stays open until S04-01.
- **No semantic fact retrieval.** Exact-key lookup is the deterministic path
  for hours/prices; embedding-based fact recall is S05/S06 and must never
  replace this lookup for the AC.
- **Seasonal variants** are modelled only by `effective_from`; a full
  seasonal calendar is out.
- **Currency** stays inside the value string (`90 EUR / masaje 60 min`) for
  v1; no conversion or price math.
- **`fact_key` was previously the fixture id**; the seed updates existing
  demo rows on conflict, so local/demo databases do not need a reset.
- **Unverified duplicates are unbounded by design.** 0001's UNIQUE is gone
  (§5.1), so repeated imports can pile up variants of one key. They are never
  answerable and S04-01's queue is what drains them; if growth ever mattered,
  the fix is a cleanup job, not a constraint that would re-break the
  contradiction case.
- **Legacy verified rows** (created before 0009) are not re-validated: they
  carry no `effective_from`, so `lookupFact` cannot return them. An operator
  must re-verify them through `verifyFact` once the row has an effective
  date. Accepted 2026-10-25 rather than aborting the migration.
- **Approved deviation record.** The DROP of 0001's UNIQUE, the replacement
  partial unique index, the `NOT VALID` CHECK and the verifier role are
  operator-approved (2026-10-25, PR #32 review round 1) and are written into
  §5.1 above so the spec and the schema no longer disagree.

## 10. Definition of done

- [x] 0009 applies cleanly and the seed fills unit/effective/source version.
- [x] Verified-only exact lookup and contradiction refusal proven in the DB
      suite.
- [x] Create/update/verify audit rows and verification reset tested.
- [x] No new dependency; no UI/route; no LLM call.
- [x] Runbook entry with evidence.
- [ ] Workbook tick after merge (separate PR, per repo workflow).
- [ ] Review threads resolved (round-1 findings addressed; replies land with
      the review-round-2 PR).

