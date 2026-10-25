---
id: S02-04
title: Seed fixtures + demo property
sprint: S02
epic: S02 — Identity, settings, audit
track: Foundation
estimate_days: 1.0
priority: P0
depends_on: [S01-01]
labels: [sprint:S02, track:foundation, prio:P0]
milestone: S02 — Identity, settings, audit
---

# S02-04 — Seed fixtures + demo property

## 1. Why

The backlog AC is "`make seed` produces a fully populated property". The plan
(§4 "The fixture hotel is adversarial on purpose") requires a deliberately
messy demo property from Sprint 1 so engineering is never blocked on hotel
content, and so chunking/contradiction/retrieval work meets real failure
shapes. The data already exists as a pure module (`src/fixtures/fixture-hotel.ts`,
W00-17: 7 article versions across the six messy cases, 5 facts, `MESSY_CASES`)
and is shape-tested — but it is not in any database, and there is no seed
command.

## 2. Goal

`make seed` (and `npm run db:seed`) populates one demo org/property with the
fixture content, four staff users (one per role), settings, facts, current
versions and the cases that cannot be published — idempotently, inside one
transaction, refusing production. The result is the shared playground for
S02-05, S03 and every later retrieval/eval item.

## 3. Acceptance criteria

**Backlog AC (verbatim):** `make seed` produces a fully populated property.

- **AC-1** On an empty migrated database, `make seed` exits 0 and produces:
  1 org, 1 property, 4 users + 4 memberships (owner/manager/front_desk/
  observer), 1 knowledge source, 7 articles, 7 versions (6 current, 1 retired
  noticeboard), 5 facts, 1 knowledge gap.
- **AC-2** It is idempotent: running it twice leaves counts unchanged, no
  duplicate rows, no errors.
- **AC-3** The six messy cases survive into the DB: flattened two-column menu,
  OCR-noisy policy, contradictory pool hours (two sources, both unverified),
  Spanish body with French prices, 3,000-word marketing article with the gym
  fact in paragraph 11, and the picture-only noticeboard (body null).
- **AC-4** The demo property's settings are valid and non-default where the
  fixture requires it (`enabled_topics` covers the fixture topics, time zone
  `America/Mexico_City`, mode `auto`).
- **AC-5** `APP_ENV=prod` is refused before any connection work; the seed only
  ever touches the `demo` org.
- **AC-6** Every row is inserted under the real RLS/migration rules (no
  `DISABLE ROW LEVEL SECURITY`, no superuser-only shortcuts); promotion goes
  through `promote_article_version()`.

## 4. Scope

**In:** `scripts/seed.ts` + `package.json` `db:seed` + root `Makefile`
(`seed` target); `src/seed/ids.ts` (stable UUIDs), `src/seed/embedding.ts`
(deterministic dev stub), `src/seed/demo.ts` (`seedDemo`); `tests/db/seed.db.test.ts`;
one contract test for the `make seed` wiring.

**Out:** real embedding provider calls (S05; S02-05 adds the re-embed job);
golden questions/evals (S08); demo UI or screenshots; WhatsApp/channel
connections; a reset/teardown command (drop the database instead); seeding
into production (refused by design).

## 5. Design

### 5.1 Fixture → DB mapping (decisions)

- The fixture ids are human keys (`demo`, `art-menu-dinner`, `fact-gym-hours`)
  but DB ids are UUIDs. `src/seed/ids.ts` exposes
  `stableUuid(key: string): string` — RFC 4122 v5 over SHA-1 with a fixed
  namespace constant. Same key always yields the same UUID, so re-runs are
  upserts.
- **Contradiction case needs two scopes.** `knowledge_articles` is unique on
  `(topic_key, scope, property_id)`, so the two `pool.hours` sources cannot
  both be property-scope. Map `poolWebsite` → `scope = 'brand'` (org-level
  source of truth from the website) and `poolDirectory` → `scope =
  'property'` (the in-room directory). Both rows exist; the contradiction is
  real and S03's contradiction detection sees it. All other articles are
  `scope = 'property'`.
- **Noticeboard is unpromotable.** `promote_article_version()` refuses a
  version whose embedding is NULL, and a picture has no text to embed.
  Therefore the noticeboard version is inserted retired (`is_current = false`,
  `embedding = NULL`) and the seed records a `knowledge_gaps` row ("Parking
  policy article has no extractable text (noticeboard photo)", language `es`,
  status `open`). This is the intended case-6 behavior, not a workaround.
- **Embeddings are a documented stub.** `src/seed/embedding.ts`
  `stubEmbedding(text, dims = 1536)` derives a deterministic vector from
  SHA-256 (normalized floats). It exists so promotion is possible without an
  LLM key and so tests are hermetic. It is **not** semantic: retrieval quality
  on seeded data is meaningless until S02-05's re-embed job replaces it with
  the real provider (S05). The stub is marked dev/demo-only in code.
- Facts map `factId → fact_key`, fixture `value/language/verified` copied as
  is; `source_id` = the single manual source; `effectiveFrom` ignored (no
  column; `created_at` default).

### 5.2 Seed graph and order

All rows share one org/property, so the transaction sets the tenant GUCs once
(`set_config('app.current_org_id'|'app.current_property_id', …, true)`) before
touching tenant tables — required because tenant tables are `FORCE ROW LEVEL
SECURITY`.

1. `organizations` (slug `demo`, stable UUID) — org-scoped policy.
2. `properties` (stable UUID, `time_zone = America/Mexico_City`,
   `ai_mode = 'auto'`, `languages = {es,en}`, `settings = DEFAULT_SETTINGS`
   with demo `enabled_topics`) — tenant policy.
3. Users + memberships: users are not tenant-scoped and their `staff_self`
   policy only exposes the caller's own row, so this block runs as
   `SET LOCAL ROLE concierge_membership` (the 0004 definer role granted to the
   migration role) — the identity surface is the only legitimate writer for
   arbitrary users/memberships. Users get stable UUIDs, demo emails
   (`owner@demo.hotelparaiso.mx`, …), `neon_auth_user_id = NULL`; memberships
   map roles 1–4. `RESET ROLE` afterwards.
4. `knowledge_sources` (one `manual` source, stable UUID).
5. `knowledge_articles` + `article_versions` (retired on insert, as required
   by the 0003 trigger), then per promotable version:
   `UPDATE article_versions SET embedding = stubEmbedding(body)` followed by
   `SELECT promote_article_version($1)` — both under the tenant GUCs, in the
   same transaction.
6. `property_facts` (5 rows, `verified = false` per fixture).
7. `knowledge_gaps` (noticeboard).

Every insert is `ON CONFLICT (pk) DO NOTHING` (stable ids make this exact);
promotion is skipped when the version is already current. The seed never
deletes rows.

### 5.3 CLI and wiring

- `scripts/seed.ts`: same flag convention as `scripts/migrate.ts`
  (`--url` overrides `$DATABASE_URL`); refuses when `APP_ENV=prod`; wraps
  `seedDemo` in `BEGIN … COMMIT`; prints a JSON summary of counts.
- `package.json`: `"db:seed": "node --experimental-strip-types scripts/seed.ts"`.
- Root `Makefile`: `seed: ; npm run db:seed` (plus `.PHONY: seed`). The
  backlog AC is literally `make seed`; Windows devs use `npm run db:seed`.
  No other Make targets are added — the repo's canonical interface stays npm.

## 6. Tenancy and security

- Seed refuses `APP_ENV=prod`; the demo org is identifiable by slug `demo`
  and stable UUID. Running it in staging is allowed and only touches that org.
- No RLS bypass: GUCs are set, the definer role is used only where the
  identity surface requires it, promotion uses the controlled function.
- No real PII: demo staff emails and guest-facing content are fictional.
- Stub embeddings are not secrets; no API keys are needed to seed.

## 7. Test plan

DB — `tests/db/seed.db.test.ts` (scratch DB, migrations applied):
- empty DB → `seedDemo` → AC-1 counts exactly; 6 current versions; noticeboard
  retired with NULL body/embedding; 1 open gap; both `pool.hours` articles
  exist with scopes `brand` and `property`; both facts present, `verified =
  false`; settings parse and include fixture topics.
- second `seedDemo` → identical counts (idempotent), no errors.
- `promote_article_version` path was used: `promoted_at` set on the 6 current
  versions; retired noticeboard has NULL `promoted_at`.
- CLI: spawn `node --experimental-strip-types scripts/seed.ts --url
  <scratch>` against a freshly migrated scratch DB → exit 0, JSON summary;
  `APP_ENV=prod` spawn → non-zero exit and no rows.
- RLS check: a property-B context sees none of the demo rows.

Unit — `tests/seed/contract.test.ts`:
- `stableUuid` is deterministic and version-5 shaped; different keys differ.
- `stubEmbedding` is deterministic, 1536-dimensional, normalized.
- `package.json` has `db:seed`; root `Makefile` has a `seed` target that
  invokes it (guards the AC literal on any platform).

## 8. Evidence

```text
$ npm run db:migrate -- --url .../concierge_local      # 5 applied
$ npm run db:seed  -- --url .../concierge_local        # {"orgs":1,...}
$ npm run db:seed  -- --url .../concierge_local        # same counts (idempotent)
$ npm run db:test                                      # seed suite green
$ make seed                                            # Linux/CI proof of the AC literal
```

Runbook S02-04 entry quotes the count JSON and the messy-case assertions.

## 9. Risks and open questions

- **Stub embeddings**: seeded retrieval is non-semantic until S02-05/S05. This
  is accepted and documented; do not use seeded retrieval results for quality
  judgments.
- **Brand vs property scope** for the pool contradiction is a modeling
  decision that S03 must honor (contradiction detection compares scopes). If
  S03 wants both as property-scope, the unique constraint must change first —
  flag it there.
- **Emails/domain** (`demo.hotelparaiso.mx`) are fictional; keep them out of
  any mail-sending path.
- **Seed data drift**: fixture module changes are fine (stable ids unchanged),
  but changing an id orphans rows on existing databases. Treat fixture ids as
  append-only.
- **Make on Windows**: `make` is not guaranteed; `npm run db:seed` is the
  portable path, the Makefile exists to satisfy the AC literally.
- **Seed must run as the migration role**: the users/memberships step uses
  `SET LOCAL ROLE concierge_membership`, which 0004 grants to the role that
  ran the migrations. Seeding with a different database role fails loudly at
  that step (accepted; `DATABASE_URL` is the same role in local/CI/Neon).

## 10. Definition of done

- [ ] `make seed` and `npm run db:seed` both work; prod refused.
- [ ] Seed is idempotent; counts and messy-case assertions tested.
- [ ] No RLS bypass; promotion via the 0003 function only.
- [ ] Runbook entry with counts + evidence; workbook tick after merge.
- [ ] Review threads resolved; out-of-scope list unchanged.
