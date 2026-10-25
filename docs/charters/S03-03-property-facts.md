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
                                AND effective_from IS NOT NULL)),
  ADD CONSTRAINT property_facts_source_version_fk
    FOREIGN KEY (org_id, property_id, source_article_version_id)
    REFERENCES article_versions (org_id, property_id, article_version_id)
    ON DELETE SET NULL (source_article_version_id);

CREATE INDEX property_facts_lookup
  ON property_facts (property_id, topic_key, fact_key, language, effective_from DESC);
```

- Existing rows get `unit = 'text'`; the seed updates the demo rows to the
  fixture units.
- `effective_from` is nullable for legacy rows; verified facts must have it.
- `source_article_version_id` is the D5 citation link; `source_id` remains
  for the source document.
- No backfill UPDATE; tenant tables are FORCE RLS. The seed's `ON CONFLICT`
  path fills the new fields.

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
new columns on an existing demo DB; counts stay 5.

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
  `effective_from <= on` (default today). Order by `effective_from DESC,
  created_at DESC`; return the first. It never embeds, ranks or generates.
- `verifyFact` locks the target row, checks for another verified row with the
  same `(topic_key, fact_key, language, effective_from)` and a different
  value; if found, throws `FactContradictionError` with both fact ids.
- `updateFact` resets `verified=false`, `verified_by=NULL`,
  `verified_at=NULL` whenever value/unit/effective/language changes; a
  metadata-only change that does not affect verification may keep it. To
  keep the rule simple and auditable, any update resets verification.
- `listContradictions` groups by `(topic_key, fact_key, language,
  effective_from)` having `count(distinct fact_value) > 1`, returning the
  values and source version ids. It reports both verified and unverified
  rows so S04-01 can show the queue.
- `createFact` starts unverified; verification is always a separate audited
  action.

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
- `verified_by` is the resolved session user id, never a request field.
- Foreign fact ids/topics return `FactNotFoundError`; no existence leak.
- `lookupFact` is deterministic and side-effect free; it is safe for the
  future guest path because it cannot generate text.
- No public route in this item; S04-01/S08 own authorization and UI.

## 7. Test plan

Unit - `tests/knowledge/facts.test.ts`:
- unit/language/date/key validation; invalid dates; closed unit set.
- `lookupFact` query shape has no embedding/LLM call (pure module test).

DB - `tests/db/facts.db.test.ts`:
- migration applies 0009; existing unverified rows satisfy constraints.
- seed: 5 facts with units/effective dates/source version ids; pool facts
  share `closing_time`; spa keys differ.
- `lookupFact` returns the verified pool value when one is verified; returns
  `null` while both are unverified (the AC's "no guess" case).
- `verifyFact` refuses the contradictory pool value; verifies the other;
  lookup then returns it.
- `verifyFact` requires an actor and sets `verified_by/at`.
- `updateFact` resets verification; lookup returns `null` again.
- `listContradictions` finds the pool pair and does not flag the two spa
  prices.
- property-B context cannot read/update property-A facts.
- audit rows exist for create/update/verify; failed audit rolls back.
- direct UPDATE of a verified fact without `verified_by` violates the CHECK.

## 8. Evidence

```text
$ npm run db:migrate -- --url .../concierge_local      # 9 applied (0009 lands)
$ npm run db:seed  -- --url .../concierge_local        # 5 facts, new fields filled
$ npm run db:test                                      # facts suite + existing suites
$ npm test                                             # fact validation units + existing suites
$ npm run typecheck && npm run lint && npm run build
```

Runbook S03-03 records the lookup/no-guess case, the contradiction refusal and
the counts.

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

## 10. Definition of done

- [ ] 0009 applies cleanly and the seed fills unit/effective/source version.
- [ ] Verified-only exact lookup and contradiction refusal proven in the DB
      suite.
- [ ] Create/update/verify audit rows and verification reset tested.
- [ ] No new dependency; no UI/route; no LLM call.
- [ ] Runbook entry with evidence; workbook tick after merge.
- [ ] Review threads resolved.
