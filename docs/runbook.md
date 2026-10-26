# Runbook — W00 and beyond

Written as items are worked, not at the end. One entry per backlog item.

## Neon backend (beyond-board infra, founder-directed) — wired and verified

The founder provisioned a Neon project (`concierge-prod`, branch `production`,
br-young-poetry-b4vbkbje) with services **postgres, auth, object-storage,
functions** via `neon init` + `neon deploy` (`neon.ts` is the policy of record).

- **Driver choice (per the Neon agent skill):** `node-postgres` (`pg`) on the **pooled** `DATABASE_URL` for app traffic; the direct `DATABASE_URL_UNPOOLED` is reserved for S01 migrations. `@neondatabase/serverless` was deliberately NOT used — it is for edge/serverless runtimes, not our long-running Node server.
- **Wired modules:** `src/neon/postgres.ts` (pool, tenant-safe later via RLS), `src/neon/storage.ts` (S3 path-style SigV4 client for the branch-scoped private bucket `assets`), `src/neon/auth.ts` (Managed Better Auth probe; client wiring lands in S02-01), `src/neon/functions.ts`.
- **Proof:** `npm run smoke:neon` → `PASS postgres v18.6 · pg_trgm + vector available · neon_auth schema present`, `PASS auth · JWKS keys 1`, `PASS storage · put→get identical → delete`, `PASS functions · HTTP 200 "Hello from Neon Functions"`.
- **App server:** `npm start` (pino JSON logs, tenant-context logger reused) serves `/healthz/{,postgres,auth,storage,function}` — all HTTP 200 with `ok` statuses; unknown paths 404.
- **Env:** `.env.local` (gitignored) holds 10 Neon variables; `.env.example` documents them.
- **Branch policy in neon.ts:** new non-default branches auto-expire (7d TTL) — staging/preview branches are therefore disposable by design; W00-13's "staging ≠ prod" closes via two branches with distinct credentials, checked by `npm run check:env`.

## Neon staging branch + two-environment gate (beyond-board infra) — wired and verified

- `neon checkout staging --create` → branch `br-red-recipe-b42k56zk` (7d-Expiring policy applies); `neon deploy` provisioned its own bucket/function/auth and pulled 10 vars into `.env.staging` (gitignored, alongside prod's `.env.local`; neither file's values may ever be printed or committed).
- `npm run check:env` now passes on real cloud values:
  `staging -> ep-wispy-math-b4ir6xpv-pooler...` · `prod -> ep-solitary-hill-b49xrkad-pooler...` (distinct hosts ⇒ no shared DB possible).
- Same `smoke-neon.ts` run against `.env.staging`: all four services PASS on staging too.
- *Note:* staging env values are quote-wrapped by the CLI; `node --env-file` strips them, but hand-rolled PowerShell parsing must `.Trim('"')`.

## GitHub repo + branch protection (Phase B §B1, W00-11) — done

- gh accounts: switched active account to **jtanori** (has `workflow` scope; Bretudev kept in keyring). Login was already done via `gh auth login`.
- `gh repo create ai-guest-concierge-1 --private --source . --remote origin --push` → **https://github.com/jtanori/ai-guest-concierge-1**, `main` pushed with tracking.
- Branch protection on a **private** repo required GitHub Pro → founder chose to make the repo **public** (`gh repo edit --visibility public --accept-visibility-change-consequences`); no secrets in git (`docs/` plan files + references to private plan URLs only, per the plan library).
- `protect-main.sh` logic applied via `gh api` (bash not available on this box): PRs required, 1 approving review, stale reviews dismissed, admins bound, linear history, no force-push/deletions.
- **AC evidence (W00-11 — "A direct push to main is rejected"):** see the GH006 rejection captured in the next runbook entry; the doc-update commit that follows is delivered correctly **via PR** instead.

## Vercel (Phase B §B2) — account + project re-linked to jtanori

- The linked-project CLI deploy flow requires either Git integration (once the GitHub repo exists → B1) or a scope token in GH secrets (`amondnet/vercel-action`); the CI `preview` job stays a stub until then. Deploying `src/server.ts` as a Vercel Node function is a later PR — W00 scope is only the link.


## W00-11 — Repo, branch protection, org setup (0.50d)

**AC (verbatim):** A direct push to main is rejected.

**Status: DONE (pending workbook tick) — both halves complete.**

- [x] Local: `git init -b main` in project root (was not a repo).
- [x] Local: `.gitignore` — rejects `.env` and `.env.*` (except `!.env.example`), node_modules, dist, coverage.
- [x] Local: PR template `.github/pull_request_template.md` — item ID + verbatim AC + evidence checklist + isolation/i18n notes.
- [x] Local: `.editorconfig` (LF, utf-8, 2-space), `.gitattributes` (LF)
- [x] Local: project scaffold — package.json, tsconfig (strict), eslint flat config.
- [x] Local: `scripts/protect-main.sh` — the exact `gh` call that applies branch protection once the remote exists.
- [x] **Remote:** repo created + pushed as `jtanori/ai-guest-concierge-1` (private at creation, made public after — see below):
  ```text
  gh auth switch --user jtanori
  gh repo create jtanori/ai-guest-concierge-1 --private --source . --remote origin --push
  gh repo edit jtanori/ai-guest-concierge-1 --visibility public --accept-visibility-change-consequences
  ```
- [x] **Protection:** `scripts/protect-main.sh` semantics applied via `gh api` (bash/WSL unavailable on this box):
  `gh api -X PUT repos/jtanori/ai-guest-concierge-1/branches/main/protection --input protect.json`
  → PRs required, 1 approving review, stale reviews dismissed, admins bound, linear history, no force-push/deletions.
- [x] **Evidence (AC test):** `git push origin main` rejected with
  `GH006: Protected branch update failed for refs/heads/main. - Changes must be made through a pull request.`

**Notes.** Private-repo branch protection requires GitHub Pro; the founder chose to publish the repo instead (repo contains only docs/tooling — secrets live in gitignored `.env.*` and were never committed). Admins are bound (`enforce_admins: true`) so the rule applies to the founder too. CI check contexts (lint/typecheck/test) can now be attached — job names exist in the W00-12 workflow.

**Protection softened for solo development (founder decision):** the founder is the only
collaborator and reviews via an AI agent commenting under their own login — which can
never approve its own PRs, so the "1 approving review" requirement deadlocked merging.
Current rule set on `main` (still friendly to a future team: everything but the review
counter survived):
- PRs still required (no direct pushes — GH006 probe still applies);
- required status checks: `lint`, `typecheck`, `test`, `preview` (non-strict, no branch staleness);
- linear history, no force-pushes, no deletions, admins bound;
- `required_pull_request_reviews` **removed** (self-merge allowed once checks pass).

**Evidence (local half, verified):**
```text
$ git log --oneline
bd14424 W00-11: repo governance — gitignore, PR template, branch-protection script, editorconfig, runbook start
6f17696 W00-11/12: project scaffold — npm toolchain, TS config, eslint, ES/EN string catalogue (D14)
```

## W00-12 — CI skeleton: lint, typecheck, test, preview (0.75d)

**AC (verbatim):** A PR produces a preview URL and a green check.

**Status: DONE (evidence below — PR #3 wire-up + this PR's own green preview run).**

- [x] Toolchain: TypeScript 5 (strict, NodeNext), vitest 3, eslint 9 (flat config), prettier 3 — npm scripts `lint`, `typecheck`, `test` under Node 24.
- [x] First module ships with its tests and obeys D14: `src/i18n/catalog.ts` — ES/EN string catalogue, key parity enforced by type + runtime test.
- [x] CI workflow `.github/workflows/ci.yml`: three required contexts (`lint`, `typecheck`, `test`) on every PR.
- [x] Local evidence: lint + typecheck + test all green.
- [x] Remote half: Actions run on the real repo — green `lint`/`typecheck`/`test` on PR #1 and every PR since.
- [x] Vercel wired via repo secrets: `vercel login` → **jtanori**, `vercel link` → `ai-guest-concierge-1`; org `team_MyTwcVzABQrWXY7JvB8qqhlS`, project `prj_3Ir8unz07uhUxzicUi5uHfMGhdx5`; secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` set with `gh secret set` (token read from the founder's local `.env.local`, never displayed). Deployment Protection (SSO) disabled via `PATCH /v9/projects/{id} {"ssoProtection": null}` so previews are publicly reachable.
- [x] `preview` job is real: `vercel deploy` of the branch → prints the unique deployment URL → curl probe on `/api/health.ts` → job fails unless HTTP 200.
- [x] **AC evidence:** PR #3's own run — `PREVIEW URL: https://ai-guest-concierge-1-grdvpdmt7-jaime-tanoris-projects.vercel.app`, probe HTTP 200 `{"status":"ok","service":"ai-guest-concierge","surface":"ci-preview-probe"}`, all four contexts green.

**Debug trail (kept deliberately):** the zero-config Node "backends" pipeline auto-detected `src/server.ts` as root entrypoint and expected `npm run build` to emit `src/server.js`; our `noEmit` tsconfig (Node strip-types is the local runtime) produced a function bundle with no code → `FUNCTION_INVOCATION_FAILED`. Resolved by pinning `@vercel/node` on `api/**` in `vercel.json` (classic functions mode; the function serves at `/api/health.ts` — the `.func` dir keeps the source extension; `rewrites` are ignored in legacy-builds mode, so the probe targets the canonical served path). Two serverless-safety fixes rode along in `src/server.ts`: bind `PORT`/`HOST` env (Vercel convention) instead of hardcoded `127.0.0.1:3000`, and boot DEGRADED without an env file (routes without their config answer 503 with the reason instead of crashing at import).

**Fork-PR limitation (documented, deliberate):** GitHub withholds repo secrets from PRs opened with a fork's token, so a fork PR can never deploy — the `preview` job is skipped for forks (`head.repo.full_name == github.repository` guard) rather than failing red noise every time. `preview` is intentionally absent from branch protection's required contexts (`lint`/`typecheck`/`test` only) so a skipped fork preview cannot dead-end a merge. If real external contributors appear, the options are: a token-light preview runner (e.g. a comment-triggered `pull_request_target` workflow with a review gate), Vercel's native Git integration, or per-fork Vercel accounts.

**Evidence (local half, verified):**
```text
$ npm run lint        # 0 problems
$ npm run typecheck   # tsc --noEmit, no errors
$ npm test            # 3 passed (3)
```

## W00-13 — Three environments: local, staging, prod (0.75d)

**AC (verbatim):** Staging and prod point at different databases.

**Status: NOT DONE — staging/prod cloud DBs pending (Phase B). Guard verified locally.**

- [x] `src/config/env.ts` — `loadConfig` refuses to boot without `APP_ENV ∈ {local, staging, prod}` and a Postgres `DATABASE_URL`.
- [x] `resolveDeploymentEnvironments` — the gate as a pure function: staging ≠ prod, and neither may reuse the local DB. Fail-fast, not a lint warning.
- [x] `scripts/check-env.ts` (`npm run check:env`) — runs the gate with real URLs (Phase B) and exits non-zero on violation; masks secrets in output.
- [x] `compose.yml` — local Postgres 17 **with pgvector** (D2/D3: embeddings populated from day one), host port 54329, named volume, healthcheck. Local only — staging/prod are cloud instances by definition.
- [x] `.env.example` — template naming all three contexts; real env files gitignored.
- [ ] **YOU (Phase B):** create two managed Postgres instances (Neon recommended — serverless, branching; or Supabase), separate regions/projects.
- [ ] **YOU (Phase B):** run `LOCAL_DATABASE_URL=... STAGING_DATABASE_URL=... PROD_DATABASE_URL=... npm run check:env` → must print `OK — no shared databases`.
- [ ] **Evidence (AC test):** the success run of `check:env` against the real staging/prod URLs. Also exercised locally with placeholder URLs (below) and 12 unit tests refusing every bad matrix.

**Evidence (local):**
```text
$ npm run check:env            # no URLs set → fails fast: "STAGING_DATABASE_URL missing or not Postgres"
$ STAGING_DATABASE_URL=postgres://demo@staging.example.com/db `
  PROD_DATABASE_URL=postgres://demo@prod.example.com/db npm run check:env
OK — no shared databases:
  staging -> postgres://staging.example.com/db
  prod    -> postgres://prod.example.com/db
```

Note: Docker Desktop was not running; `compose up -d` verification pending — retry before S01 (the local DB is not needed for the W00-13 AC itself).

## W00-14 — Error tracking + structured logging (0.50d)

**AC (verbatim):** A staging error carries org_id, property_id, conversation_id.

**Status: NOT DONE — Sentry DSN pending (Phase B). Logging contract verified by test.**

- [x] `src/logging/index.ts` — pino JSON logger; `bindRequestContext` requires the full `{orgId, propertyId, conversationId}` record at the type level (a logger bound without tenant context does not typecheck).
- [x] `reportError` — stamps the error line with the same three fields and optionally forwards to a reporter (Sentry in Phase B).
- [x] Tests assert the captured JSON line contains `org_id`, `property_id`, `conversation_id` (5 tests, all pass).
- [ ] **YOU (Phase B):** create the Sentry project (error-tracking account), set `SENTRY_DSN` in the staging env vars.
- [ ] **Evidence (AC test):** the staging smoke throw (below) appears in Sentry with the three context fields.

**Evidence (local):**
```text
$ npm test   # 17 passed — includes the 5 logging-contract tests
```

Smoke command for staging once Sentry is wired (route arrives with the first web server in S01; context printed as headers):
```text
curl -X POST https://<staging-host>/debug/throw `
  -H "x-org-id: org-smoke-1" -H "x-property-id: prop-smoke" -H "x-conversation-id: conv-smoke"
```

## W00-15 — Golden set v1: format + 20 starter questions (0.50d)

**AC (verbatim):** File format agreed; 20 questions in the repo.

**Status: DONE to the extent of its AC — format enforced by test, 20 questions committed.** (Content grows to v2 — 40-50 — in S03 before G1 freezes it.)

- [x] Format = plan Appendix A CSV verbatim: `property_id,language,question,expected_behaviour,target_topic,notes` — `expected_behaviour ∈ {answer | escalate | refuse}`, never an expected string.
- [x] `src/golden/validate.ts` — RFC-4180 parser + rule validator (typed module, no new deps).
- [x] Rules with teeth: answer rows must name a topic; escalate rows must NOT (they are the questions the KB does not answer); escalate/refuse rows need a hand-written rationale note; language must be one of the property's languages; 20-row minimum; **escalation share ≥25% floor** — a golden set biased toward what the KB answers would defeat the false-answer gate.
- [x] `data/golden/golden-questions-v1.csv` — 20 questions: 13 answer-expected (aligned to the plan's content-section topics: pool.hours, dining.hours, parking, checkin, spa, transport, wifi) + **7 escalation cases hand-written** (booking intent ×3, refund/cancel, dispute, allergy/dining, accessibility — per plan §4 this third is authored by humans, never generated).
- [x] 13 tests including the malformed-set rejections.

**Evidence (committed, verified):**
```text
$ npm test   # 30 passed (30) — 13 of them the golden-set format tests
```

Items the AC does NOT cover (and are therefore not invented here): the golden set v2 (40-50 questions) freezes at G1 (S03) with real hotel content; scoring (answer/escalate/false/needless) is the S06 eval harness.

## W00-17 — Adversarial fixture hotel (0.50d)

**AC (verbatim):** Seeded in staging; every messy case reproducible.

**Status: NOT DONE — staging seed pending (Phase B; needs the staging DB from W00-13 and the S02 seed machinery). Data pack + per-case reproducibility tests verified locally.**

- [x] `src/fixtures/fixture-hotel.ts` — the demo property ("demo") with all six messy cases from plan §4, as immutable article **versions** (D5 UUIDs) + structured facts:
  1. `menu-flattened-two-column` — two-column PDF menu flattened to one-column dish+price pairs
  2. `ocr-noise-scan` — scanned policy with digit-for-letter OCR noise
  3. `contradiction-pool-hours` — two `pool.hours` facts, one topic_key, different values (21:00 vs 20:00) **and both unverified** — the case contradiction detection must refuse to resolve silently
  4. `spa-prices-foreign-language` — article body `es`, price facts arrive in `fr`
  5. `marketing-fact-buried-paragraph-11` — ≥3,000-paragraph-worthy marketing article (~3,200 words, deterministic) whose sole useful fact (`gym.hours` = 24/7) sits in paragraph 11 once
  6. `noticeboard-picture-only` — `body: null`; the version stays citable while nothing can be chunked/embedded
- [x] `MESSY_CASES` — machine-readable case registry (id, what breaks, which version).
- [x] Tests: one explicit reproducibility assertion per case + D5 integrity (every fact resolves to an existing article **version**, never an article row).
- [x] noUncheckedIndexedAccess/strict type settings apply to the fixture itself.
- [ ] **YOU (Phase B):** once staging exists (W00-13) and the S02 seed builder lands, run the fixture seed against staging (`docker compose exec` equivalent) — the six cases must each be present and the two `pool.hours` rows must be flagged unresolved.
- [ ] **Evidence (AC test):** the staging seed run logs each of the six case ids.

**Evidence (local, verified):**
```text
$ npm test   # 48 passed (48) — 9 fixture-reproducibility tests
$ npm run typecheck && npm run lint   # clean
```

## W00-19 — Event taxonomy written (0.50d)

**AC (verbatim):** 18 events merged as a typed module; contract test passes; no dashboard before this exists.

**Status: DONE — 18-event typed module, contract test holds it against Appendix C verbatim.**

- [x] `src/events/taxonomy.ts` — `EVENT_NAMES` (18, Appendix C order), `Event`/`EventContext` types carrying the seven mandatory fields: `org_id`, `property_id`, `conversation_id`, `channel`, `language`, `topic`, `created_at`.
- [x] `staff_message_sent` shipped as the 18th event per the v1.2.1 ruling — containment = conversations with zero staff messages, and staff can reply without a takeover (and repeatedly). `answer_overridden` deliberately absent (declined in v1.2.1 as derivable).
- [x] `createEvent(type, ctx, data)` — fail-fast factory: throws on empty tenant fields, non-ISO `created_at`, or unknown channel. An event that a rollup would silently drop is not emitted.
- [x] Contract test copies Appendix C verbatim into the test and asserts equality — if the module ever drifts from the plan, the build fails. Plus 18-name uniqueness, snake_case, context-field assertions.
- [x] The `events` table itself is S01 schema (RLS-gated) — zero table code written this week, honoring Rule 1.
- [x] No dashboard tile, query or rollup exists — nothing can precede this contract.

**Evidence (committed, verified):**
```text
$ npm test   # 39 passed (39) — 10 taxonomy contract tests
$ npm run typecheck && npm run lint   # both clean
```

## S01-01 — Schema and migrations (3.00d)

**AC (verbatim):** Runs clean from an empty database; ERD committed.

**Status: DONE — three ordered SQL migrations + pooled runner + committed ERD.**

- [x] `db/migrations/0001_init.sql` — all 25 plan §2 tables (D1) created with
  `CREATE EXTENSION vector` / `pg_trgm` up front: organizations, properties,
  users, memberships, roles, channel_connections, channel_identities,
  conversations, messages, message_delivery_events, service_requests,
  assignments, internal_notes, knowledge_sources, knowledge_articles,
  article_versions, property_facts, ai_runs, citations, handoff_reasons,
  knowledge_gaps, events, rollups, audit_log, outbox.
- [x] D2/D3 retrieval columns ship day one: `embedding vector(1536)` + GIN
  `tsv` (generated tsvector, `english` config) + trigram indexes on
  `article_versions` and `property_facts`; HNSW (`vector_cosine_ops`) on the
  two embeddings.
- [x] D5 FK: `citations.ai_run_id → ai_runs` and `citations.article_version_id
  → article_versions` (verifying citations to a *version*, never an article).
- [x] D7 outbox: statuses `pending/sending/sent/failed/dead` — DLQ is the
  `dead` state (exhausted retries), partial index keeps the active queue hot.
- [x] D10: `events` CHECK list textually equals `src/events/taxonomy.ts`
  (18 names, Appendix C order); `event_type` for a staff message is
  `staff_message_sent` with no `taken_over` precondition (mid-conversation
  replies stay legal); `audit_log`/`events`/`article_versions`/are
  append-only via triggers (0003) — an UPDATE/DELETE raises `append-only`.
- [x] `schema_migrations` bookkeeping table; runner records sha256 checksum
  and re-runs are no-ops (idempotent).
- [x] `src/db/migrate.ts` — pooled runner (one client per file + tx-per-file
  rollback on error), `scripts/migrate.ts` CLI (`npm run db:migrate`). The
  earlier single-Client implementation hit "Client has already been
  connected" on scratch reuse — Pool-based runner fixes it.
- [x] `db/erd.mmd` committed; the suite's drift test re-derives the entity
  list from the live database and fails if it diverges from the ERD.
- [x] Empty-database proof: every db suite runs against `scratch_<pid>` —
  a database created by `CREATE DATABASE` from nothing, then all three
  migrations applied by the real runner (`recreateScratch` erases it after).
- [x] Review round (PR #5): composite tenant-aware FKs added — every tenant
  table now carries `FK (org_id, property_id) → properties (org_id,
  property_id)` and every tenant-child reference is a triples-composite FK
  `(org_id, property_id, parent_id) → parent`, so a tenant B context can no
  longer smuggle known tenant A IDs into single-column FKs; nullable
  composite refs use PG15+ `ON DELETE SET NULL (child_col)` so the NOT NULL
  tenant columns stay intact. The runner now verifies stored checksums and
  fails loudly (not silently) when an applied migration file is edited.
  D3 current-version marker landed: `article_versions.is_current` with a
  partial unique index (one current row per article). Second review round
  refined the flow to embed-FIRST: versions insert retired
  (`is_current DEFAULT false`); promotion is the controlled atomic
  promoted via the controlled `promote_article_version()`, which refuses
  to publish before the embedding exists and whose trusted context is a
  dedicated NOLOGIN role (`concierge_promoter`, function-OWNER-carried and
  column-scoped), not a settable GUC — raw `is_current` UPDATEs and the
  INSERT-true route are both trigger-blocked and tested; 0003's
  append-only guard otherwise permits only demotion-in-promotion and
  embedding backfill — so the previous version stays live until its
  replacement is ready. Third round closed the definer's gaps: the
  promotion function verifies the CALLER's tenant context
  (`app.current_org_id`/`app.current_property_id` must match the target
  version — no-context and known-foreign-version calls are refused), public
  EXECUTE is revoked after the ownership transfer (ALTER resets the ACLs to
  the PUBLIC default, which is why the REVOKE post-ALTER), membership in
  `concierge_promoter` is granted BEFORE the ownership transfer so a
  non-superuser Neon role can run the ALTER, and the function's only
  EXECUTE callers are the migration owner and `concierge_app`.
  Fourth round made history strictly one-way: `promoted_at` is stamped at
  the first promotion and can never be rewritten (a timestamp on an
  already-promoted row raises), and the function itself refuses retired
  targets — re-promoting v1 after v2 is live raises "was promoted once and
  is retired history".

**Evidence (local, verified):**
```text
$ npm run db:test   # 25 passed (25) — incl. clean-from-empty on scratch_<pid>
$ npm run typecheck && npm run lint && npm run build   # all clean
```

## S01-02 — Row-level security (2.00d)

**AC (verbatim):** A query without tenant context returns zero rows.

**Status: DONE — FORCE RLS everywhere + app-layer `withTenant` guard.**

- [x] `db/migrations/0002_rls.sql` — FORCE ROW LEVEL SECURITY + named
  `tenant` policies on all 21 tenant tables (the 25 minus
  organizations/users/roles/memberships); property-scoped tables require
  BOTH `app.current_org_id` and `app.current_property_id` to match the
  row, so an org/property mismatch pair yields zero rows too; `with check`
  mirrors `using`, so cross-tenant inserts are rejected, not silently
  dropped.
- [x] Tenant context rides GUCs (`app.current_org_id` /
  `app.current_property_id`, empty string → NULL) — per-transaction LOCAL,
  never per-session global.
- [x] `concierge_app` NOLOGIN role created with grants + ALTER DEFAULT
  PRIVILEGES; superusers/owners bypass RLS by design, so the suites run
  under `SET LOCAL ROLE concierge_app` to behave like the deployed app.
- [x] `src/db/tenant.ts` — `withTenant(client, {orgId, propertyId}, fn)`:
  validates UUIDs up front (throws `TenantContextError` on empty/malformed),
  binds via `set_config(...$1...)` (SET cannot take parameters), resets
  cleanly after COMMIT and rolls back on callback throw.
- [x] The AC is proven for every tenant table, not one: with NO context at
  all, `SELECT count(*)` on all 21 tables returns zero.
- [x] Review round (PR #5): RLS is now the FIRST line of defense for
  cross-tenant VALUES (with check rejects mispaired org/property inserts
  before the FK), while the composite FKs (S01-01) are the structural
  backstop once a bypassing session is involved — both behaviors are tested
  (see S01-03).

**Evidence (local, verified):**
```text
$ npm run db:test   # 25 passed (25) — AC asserted across all 21 tables
```

## S01-03 — Cross-tenant isolation test harness (0.75d)

**AC (verbatim):** Suite runs in CI and fails the build on a leak.

**Status: DONE — policy-derived enumeration + owner-ground-truth leak sweep + `db-test` CI job.**

- [x] `tests/db/isolation.db.test.ts` enumerates tenant tables FROM the
  database (`pg_policies` rows with policyname `tenant`) and asserts the set
  equals the 21 expected tables — a schema change that adds a tenant table
  without a policy (or forgets RLS entirely) fails the suite.
- [x] The sweep seeds two full tenant graphs, then for every tenant table
  asserts: context A sees exactly the owner-side count of org-A rows,
  context B sees exactly org-B rows, both counts > 0 — a visible-count that
  exceeds its org's real row count IS a leak, in either direction.
  (An earlier naive "foreign context sees zero rows" assertion was
  red-flagged by properties — an org legitimately sees its own row — the
  ground-truth comparison is the correct invariant.)
- [x] Write-direction checks: org-B context cannot INSERT into org-A rows on
  `properties` (org-scoped) nor `messages` (property-scoped) — `with check`
  rejects.
- [x] `tests/db/helpers.db.ts` maintains the scratch database lifecycle
  (`scratch_<pid>`, created empty, dropped after) exercising the real
  migration runner; `asTenantApp` drops the session into `concierge_app`.
- [x] `npm test` excludes `tests/db/**` (new root `vitest.config.ts`) so the
  unit job stays hermetic; the dedicated `tests/db/vitest.db.config.ts`
  gives 60s hooks and single-worker runs.
- [x] CI: new `db-test` job in `.github/workflows/ci.yml` — `pgvector:pg17`
  service container (ports 54329), `TEST_DATABASE_URL` env, `npm run
  db:test`. `db-test` added to main's required status checks, so any leak
  blocks the merge.
- [x] Review round (PR #5): leak suite extended beyond row-visibility —
  cross-tenant REFERENCES are asserted too (messages pointing at a foreign
  conversation are impossible: RLS hides the referenced rows from
  selecting, and the composite FK blocks a smuggled ID); mispaired
  org/property values are rejected by `with check` under an app context and
  by the pair FK under a bypassing session; the checksum-guard tamper test
  proves a rewritten applied migration fails the build.

**Evidence (local, verified):**
```text
$ npm run db:test   # 25 passed (25)
$ npm test          # 48 passed (48) — unit job unaffected
```

## S02-01 - Auth + four roles (2.00d)

**AC (verbatim):** Each role can only reach its own surface.

**Status: DONE (2026-10-25) — the verbatim AC is now enforced by a production surface, not only by the matrix.** S02-06 (GitHub issue #14) closed inside S04-01: `src/knowledge/review.ts` calls `session.requireRole("knowledge", "write" | "read")` as the first statement of every exported function, so `POST /api/review/versions/:id/approve|reject` and `POST /api/review/contradictions/resolve` are unreachable for `front_desk` and `observer`, and `tests/db/role-denial.db.test.ts` proves it against a real database with a real signed JWT and counts of `article_reviews`, `fact_resolutions`, `audit_log` and verified facts taken before and after every refusal (zero writes). The 2026-10-24 decision stands: no test-only service wrapper was added; the guard is exercised through the route a staff member actually calls.

- [x] Neon Auth (managed Better Auth) is the identity provider. `src/auth/session.ts` verifies bearer JWTs against the branch JWKS (ES256 / RS256 / PS256 / EdDSA via node:crypto; kid-based key resolution with one refresh on rotation). Review round 2 hardened it: the JWK must bind to the token header (same kid/alg, kty/crv per alg, no private `d`, no conflicting `use`/`key_ops` — real Neon keys omit both, so absence is allowed); ES256 accepts ONLY the 64-byte JOSE r||s form (DER is rejected, no canonicalization); `iss`/`aud`/`nbf`/`iat`/finite `exp` and a verified email (`email_verified` or Better Auth's `emailVerified`) are enforced; `StaffIdentity` is branded with a module-private symbol and `fakeIdentity` is gone, so only the verifier can mint a session identity. Token claims never carry authority — roles never come from them.
- [x] `db/migrations/0004_auth.sql` stops treating users/memberships as global: `staff_select`/`staff_update_name` show each staff member only their own users row, and the app role's table-wide DML on users is revoked — only `UPDATE (display_name)` remains (no email takeover, no inserts/deletes). Memberships carry command-split policies: `membership_select` (own row or same-property staff), `membership_insert`/`membership_update` owner-ONLY via the `with check` clause role_id=1, `membership_delete` owner-only plus the caller's own row. `provision_user` is a race-safe single-statement upsert that NEVER rewrites an existing identity (email and display_name immutable; display_name only fills a NULL); an email bound to another Neon user surfaces as `EmailCollisionError` (23505) and rolls the login back.
- [x] Role resolution happens IN the database: `current_membership_role(property_id)` is a SECURITY DEFINER that reads the caller's membership for `app.current_user_id`. The definer context belongs to the cluster-scoped NOLOGIN role `concierge_membership`, and the migration owner's membership is REVOKED before COMMIT (0004) — otherwise the deployed Neon login role (which is the migration owner) could `SET ROLE` into the definer's `USING(true)` policy and bypass RLS (review round 2, 4369257029). `0005_auth_hardening.sql` applies the same revoke to 0003's `concierge_promoter`, grants both definer roles CREATE on the schema (required by `ALTER FUNCTION ... OWNER` under a non-superuser migrator), and grants `concierge_app` to the login role. `0003` was amended pre-deployment to grant CREATE before its ownership transfer; any database that applied the earlier checksums (local `concierge_local`) must be recreated.
- [x] Runtime sessions actually run as `concierge_app`: the pool is built with the startup option `-c role=concierge_app` (`src/neon/postgres.ts:appPoolConfig`), and `withStaffSession` additionally issues `SET LOCAL ROLE concierge_app` so tests/scripts/misconfigured pools cannot run tenant work as the table-owning login role (review round 2, 4369257062). `tests/db/non-superuser.db.test.ts` creates a plain LOGIN owner, runs the full migration chain as it, and proves function ownership, no usable (inherit/SET) access to either definer role, effective FORCE RLS, and the pool's role.
- [x] `src/auth/guard.ts` is the single surface matrix: owner/manager/front_desk/observer x org/knowledge/settings/queue/analytics x read/write. Manager authors knowledge + settings but never admin (org); front_desk works the queue, reads knowledge; observer is read-only everywhere; grants are monotone under the owner. `requireRole` throws a named `RoleNotOnSurfaceError`. Exhaustively tested in `tests/auth/guard.test.ts`; S02-06 wires it into the first route.
- [x] `src/auth/context.ts` mirrors withTenant: one transaction drops to `concierge_app`, sets tenant GUCs, provisions the identity, sets `app.current_user_id`, resolves the role through the DB helper, refuses before any tenant work (no membership -> `NoMembershipError`), and yields a session whose `requireRole` is bound to the resolved role. `tests/db/context.db.test.ts` proves the production shape end to end: role from memberships (a forged `role: owner` token claim is ignored), no-membership rollback, email collision, forged-identity refusal, a denied settings write leaving the property untouched, GUC locality, concurrent first-login idempotency, and immutable identity fields.
- [x] CI: `tests/db/auth.db.test.ts` proves the DB-anchored half — all four roles resolve to their role_id under RLS; a property-A staff member holding a property-B context gets no membership; membership rows of property B are invisible from A; manager inserts/updates are rejected by policy, while the GM's legitimate grant on their own property lands and extending it to another property is refused; users/memberships are invisible without context; provisioning is idempotent and rejects an email collision.

**Product sign-off (2026-10-24):** the six surfaces (including the S02-03 `audit` surface) and their per-role grants are the contract approved with the S02-02 and S02-03 charters (`docs/charters/`); they are recorded here so the matrix is not an invented feature. This is sign-off for the contract only - enforcement still lands with S02-06.

**Evidence (local, verified):**
```text
$ npm run db:test   # 54 passed (54) - includes context/non-superuser/runtime-role suites
$ npm test          # 70 passed (70) — units include the JWKS verify surface
$ npm run typecheck && npm run lint && npm run build   # all clean
$ npm run db:migrate -- --url .../concierge_local      # 5 applied (0005 lands)
```

**Review round 2 residual (documented, not silently dropped):** PostgreSQL
records the CREATEROLE creator's automatic grant to a role it created as an
inert membership (`MEMBER=true`, but `inherit_option=false`,
`set_option=false`; verified in `tests/db/non-superuser.db.test.ts`). The
migrations revoke the *active* grant they add, so the deployed login role
cannot inherit or `SET ROLE` into either definer role. The inert row also
carries ADMIN OPTION, so an attacker who already has arbitrary SQL as the
login role could re-grant it to themselves - the same "the process holds the
DB credential" boundary as `RESET ROLE`, not the accidental-bypass bug this
round fixes. Closing that fully needs a definer role not created by the
login (superuser-provisioned), which Neon does not expose to migrations; the
runtime pool additionally pins every session to `concierge_app`.

## S02-02 - Property settings (1.00d)

**AC (verbatim):** AI policy layer reads settings, does not hardcode.

**Status: DONE (2026-10-24).** The settings contract, policy module and tenant-scoped store are merged; no HTTP route is in scope (S04).

- [x] `0006_property_settings.sql` makes `settings` a closed, typed contract: `property_settings_valid(settings, ai_mode)` is an IMMUTABLE plpgsql validator used by CHECK `properties_settings_valid`, the column default is the full `DEFAULT_SETTINGS`, and `properties_languages_supported` enforces a non-empty subset of `{es,en}`. `'{}'` remains the only partial value (legacy/unset) and parses to defaults; there is no backfill UPDATE because tenant tables are FORCE RLS. The validator returns false for malformed types instead of raising.
- [x] `src/settings/schema.ts` mirrors the DB rules with path-aware `SettingsValidationError` (`business_hours[3].open`), exports `DEFAULT_SETTINGS`/`SETTINGS_KEYS`, and `mergeSettings` replaces top-level keys then re-validates. Unknown keys are rejected (closed set), an all-closed week is refused, and `{}` returns a fresh default copy.
- [x] `src/settings/policy.ts` is pure and reads nothing but `(settings, ai_mode, now, time_zone)`: `isTopicEnabled`, DST-correct `localMinutes`/`isAfterHours` via `Intl`, `escalationDecision` for all four modes, and `spendCaps`. Empty `enabled_topics` means every topic escalates under `auto`.
- [x] `src/settings/store.ts` is tenant-scoped: `loadPropertySettings` parses the stored JSON (or `'{}'`), `savePropertySettings` merges, validates, updates only the addressed `(org_id, property_id)`, returns the changed top-level keys (the input S02-03 will audit), and throws `PropertyNotFoundError` when the row is not visible.
- [x] Tests: `tests/settings/schema.test.ts` (16), `tests/settings/policy.test.ts` (8, incl. America/New_York spring-forward), `tests/db/settings.db.test.ts` (8: column default, legacy `{}`, save/re-read/changed, direct CHECK failures incl. malformed types and after_hours all-closed, languages, cross-tenant read/write). `schema.db.test.ts` and `non-superuser.db.test.ts` now expect 6 migrations.

**Decisions carried from the charter:** spend caps `10`/`0.50` USD are placeholders until S07; tone enum is `warm_professional|concise|formal`; overnight hours are refused in v1; audit rows for settings writes are S02-03, sequenced in the same sprint.

**Evidence (local, verified):**
```text
$ npm run db:migrate -- --url .../concierge_local      # 6 applied (0006 lands)
$ npm run db:test                                      # 62 passed (62)
$ npm test                                             # 94 passed (94)
$ npm run typecheck && npm run lint && npm run build   # all clean
```

## S02-03 - Audit log (1.00d)

**AC (verbatim):** Every consequential action writes an audit row.

**Status: DONE (2026-10-24).** One write path, one closed vocabulary, one read path, and the first real call site (settings) are merged. Future actions add their call site when they land; this item does not claim every future action is already audited.

- [x] `src/audit/actions.ts` is the closed vocabulary: 10 actions and 8 entity types, with `isAuditAction`/`isEntityType`. The DB keeps `action text` (no CHECK) so the app can add an action without a migration; the TS union is the gate.
- [x] `src/audit/write.ts` validates action/entity types, org/property/actor UUIDs and non-empty `entityId`, then inserts one row with `RETURNING audit_id`. It takes the caller's client, so it runs in the caller's transaction; a failed insert aborts the mutation. No SECURITY DEFINER.
- [x] `src/audit/detail.ts` rejects unsafe detail keys by token (`body`, `message_body`, `content`, `card`, `pan`, `token`, `secret`, `password`, including camelCase and nesting) and rejects undefined/function/bigint/non-finite/Date/circular values. `{changed: ["tone"]}` passes; `{company: "..."}` is not a false positive.
- [x] `src/audit/read.ts` lists a property's rows newest-first (`audit_id DESC`), clamps `limit` to 1..200 (default 50), and uses `beforeId` as an exclusive bigint cursor. RLS scopes the result; all four roles may read.
- [x] `src/audit/support.ts` writes `support.access` with `entity_type='property'`, `entity_id=property_id`, and detail `{operator_email, reason, ticket?}`; empty operator/reason is refused. Authorization (platform-admin) is S10 and deliberately not here.
- [x] `src/settings/store.ts` now requires `actor: { userId }` and writes `settings.updated` with `{changed}` in the same transaction after the UPDATE. A no-op save writes no audit row. S02-02 tests updated.
- [x] `src/auth/guard.ts` gains the `audit` surface: owner/manager/front_desk/observer all `read`, nobody `write`. Matrix test extended.
- [x] `0007_audit_privileges.sql` revokes UPDATE/DELETE on `audit_log` from `concierge_app`; 0003's append-only trigger remains the second layer (proved as the owner role).
- [x] Tests: `tests/audit/actions.test.ts` (4), `tests/audit/detail.test.ts` (5), `tests/db/audit.db.test.ts` (7: atomic settings+audit, rollback on failed audit, newest-first/limit/beforeId/observer read, cross-property invisibility, UPDATE/DELETE refusal, support access, no audit write role). `schema.db.test.ts`/`non-superuser.db.test.ts` now expect 7 migrations.

**Wired call sites:** `savePropertySettings` -> `settings.updated`. **Call-site rule:** each future item adds its own `writeAudit` call inside the mutation's transaction and documents its `detail` keys in its charter; no route writes audit rows directly.

**Evidence (local, verified):**
```text
$ npm run db:migrate -- --url .../concierge_local      # 7 applied (0007 lands)
$ npm run db:test                                      # 69 passed (69)
$ npm test                                             # 104 passed (104)
$ npm run typecheck && npm run lint && npm run build   # all clean
```

## S02-04 - Seed fixtures + demo property (1.00d)

**AC (verbatim):** `make seed` produces a fully populated property.

**Status: DONE (2026-10-24).** `npm run db:seed` seeds the demo graph idempotently; the root `Makefile` exposes the literal `make seed` target. The target itself was not executed on this Windows box (no `make`); `tests/seed/contract.test.ts` guards the Makefile wiring and the DB suite exercises the same CLI path.

- [x] `src/seed/ids.ts` derives RFC 4122 v5 UUIDs from stable keys (`org:demo`, `property:demo`, `user:*`, `article:*`, `fact:*`) with a fixed namespace, so re-runs address the same rows.
- [x] `src/seed/embedding.ts` is the documented dev stub: SHA-256 -> xorshift -> normalized 1536-float vector. It is deterministic and hermetic, not semantic; S02-05/S05 replace it with the real provider.
- [x] `src/seed/demo.ts` seeds in one transaction with tenant GUCs: org/property (time zone `America/Mexico_City`, mode `auto`, languages `{es,en}`, non-default `enabled_topics`), four staff users + memberships, one manual source, 7 articles + 7 versions, 5 facts, 1 open gap. Every insert is `ON CONFLICT DO NOTHING`; promotion is skipped when already current.
- [x] Identity rows use `concierge_membership` (the only legitimate writer for arbitrary users/memberships). Because 0004/0005 revoke that role from the login role, the seed grants it inside a savepoint, sets the role, inserts, then revokes before release; a failure rolls the grant and rows back together.
- [x] Versions are born retired and promoted only through `promote_article_version()` after a stub embedding backfill. The noticeboard is inserted retired with `body = NULL`, `embedding = NULL`, `promoted_at = NULL`; its gap row is `Parking policy article has no extractable text (noticeboard photo)` (`es`, `open`).
- [x] `0008_article_versions_body_nullable.sql` drops the 0001 `body NOT NULL` because AC-3/AC-6 require the picture-only version to have no body. This is the only schema change; retrieval already treats NULL tsv/embedding as non-retrievable.
- [x] Contradiction modeling: `poolWebsite` is `scope='brand'`, `poolDirectory` is `scope='property'`; both rows and both unverified facts (`21:00` / `20:00`) survive. All other articles are property-scope.
- [x] CLI `scripts/seed.ts` refuses `APP_ENV=prod` before connecting, wraps `seedDemo` in `BEGIN/COMMIT`, and prints the count JSON. `package.json` has `db:seed`; `Makefile` has `.PHONY: seed` -> `npm run db:seed`.
- [x] Tests: `tests/seed/contract.test.ts` (3: v5 shape/determinism, stub embedding shape/norm, wiring), `tests/db/seed.db.test.ts` (6: exact counts/6 current, idempotent second run, all six messy cases, settings/topics, cross-tenant invisibility, CLI success + prod refusal). `schema.db.test.ts`/`non-superuser.db.test.ts` now expect 8 migrations.

**Evidence (local, verified):**
```text
$ npm run db:migrate -- --url .../concierge_local      # 8 applied (0008 lands)
$ npm run db:seed  -- --url .../concierge_local
{"orgs":1,"properties":1,"users":4,"memberships":4,"knowledge_sources":1,"knowledge_articles":7,"article_versions":7,"property_facts":5,"knowledge_gaps":1}
$ npm run db:seed  -- --url .../concierge_local        # same JSON (idempotent)
$ npm run db:test                                      # 75 passed (75)
$ npm test                                             # 107 passed (107)
$ npm run typecheck && npm run lint && npm run build   # all clean
```

`make` is not installed on this Windows dev box; the AC literal is covered by the Makefile contract test, and Linux/CI can run `make seed` against `$DATABASE_URL`.

## S02-05 - is_current retrieval filtering + re-embed job (0.50d)

**AC (verbatim):** Editing an article makes its old chunks unretrievable.

**Status: DONE (2026-10-24).** The retrieval primitive hard-filters `is_current` in both SQL paths, and `reembedAndPublish` embeds + promotes as one unit of work. No schema change and no new dependency.

- [x] `src/knowledge/retrieval.ts` (`retrieveCurrentVersions`): one mode per call. Lexical uses `websearch_to_tsquery('simple', $1)` + `ts_rank`; vector uses cosine similarity (`1 - (embedding <=> $1::vector)`). Both statements contain the literal `AND av.is_current` plus `body IS NOT NULL`; RLS supplies the tenant scope. `limit` defaults to 8 and clamps 1..50.
- [x] No include-retired escape hatch: `RetrievalInput` has no such option and the DB test pins the source to exactly two literal `AND av.is_current` occurrences.
- [x] `src/knowledge/reembed.ts` (`reembedAndPublish`, `Embedder` port): typed `VersionNotFoundError` (unknown and foreign-tenant ids are indistinguishable), `UnembeddableVersionError` (NULL body), `VersionAlreadyCurrentError`, `EmbeddingDimensionError`. It selects under the caller's tenant GUCs, embeds, writes only `embedding`, then calls `promote_article_version()`.
- [x] Atomicity is the caller transaction: a failed promotion rolls the embedding write back with it, so there is no half-published version. 0003's trigger remains the history/body enforcement.
- [x] `src/knowledge/embedding.ts`: exactly 1536 finite floats; rejects wrong length, NaN/Infinity, non-arrays and typed arrays; `toVectorLiteral` is the pgvector text form.
- [x] Tests: `tests/db/retrieval.db.test.ts` (8: v1 current, publish v2, old token zero / new token v2, history intact, vector path filtered, strongest retired match excluded, no bypass + SQL snapshot, five typed refusals, promotion-failure rollback). `tests/knowledge/embedding.test.ts` (5 validator/literal cases).
- [x] Wiring rule for S05: the answer pipeline must call `retrieveCurrentVersions`, never raw SQL; publish goes through `reembedAndPublish`. Hybrid ranking and chunking remain S05/schema items.
- [x] Stub embeddings remain non-semantic; retrieval quality is not judged until S05 wires the real provider.

**Evidence (local, verified):**
```text
$ npm run db:test                                      # 83 passed (83), incl. 8 retrieval
$ npm test                                             # 112 passed (112), incl. 5 embedding
$ npm run typecheck && npm run lint && npm run build   # all clean
```
## S03-01 - Article editor + immutable versioning (2.00d)

**AC (verbatim):** Editing never alters a historical version.

**Status: DONE (2026-10-24).** `src/knowledge/articles.ts` is the tenant-scoped authoring service: create, edit, list, version list and version detail. Edits append a new retired version; publishing stays in S04-01. No schema change, no HTTP route, no `requireRole` (S04-01 owns the guard).

- [x] `createArticle` inserts one `scope='property'` article and a retired version 1, then writes `article.version_created` (`article_version`, detail `{topic_key, version_no, has_text, language}`). A duplicate property topic is `ArticleTopicConflictError`; a foreign/unknown `sourceId` is `ArticleSourceNotFoundError`.
- [x] `editArticle` locks the article row (`FOR UPDATE`), computes `max(version_no)+1`, and appends a retired version when the body changes. The old row is untouched (0003 trigger). A unique race is `ArticleVersionConflictError`.
- [x] No-op edits (same body/title/language/source) create no version and no audit row. Title/language/source-only edits update `knowledge_articles` and write `article.updated` (`{changed}`) without a version. `topicKey` cannot change on edit.
- [x] `sourceId: undefined` preserves the existing source on edit; `sourceId: null` clears it; create normalizes omitted to `null`.
- [x] `body: null` is supported for picture-only articles; empty/whitespace body is rejected, max 200,000 chars. Title max 200; topic max 120 and lowercase dot/underscore/dash segments; language is `es|en` (normalized case).
- [x] `listArticles` returns property-scope articles only (brand scope is excluded) with `versionCount` and the current version (null until S04-01 publishes). `listVersions` returns newest-first summaries with a 160-char preview; `getVersion` returns the full body and metadata. Foreign ids are not found; malformed ids are validation errors.
- [x] Audit vocabulary grows to 12 actions: `article.version_created` and `article.updated` (entity types `article_version` / `article`). Audit detail never contains the body; the boolean key is `has_text` because `body_present` is correctly rejected by the detail guard.
- [x] Tests: `tests/knowledge/articles.test.ts` (8 validation cases), `tests/db/articles.db.test.ts` (12: create+audit, duplicate topic, append/old-body-intact, no-op, metadata-only, source preserve/clear, null body, current version after `reembedAndPublish`, foreign isolation, brand exclusion, topic-key refusal, audit-failure rollback). Existing audit action test updated.
- [x] No `requireRole` call: S03-01 is a service, S04-01's first staff route will call `session.requireRole("knowledge", "write")` and close S02-06.

**Evidence (local, verified):**
```text
$ npm run db:test                                      # 95 passed (95), incl. 12 articles
$ npm test                                             # 120 passed (120), incl. 8 article validation
$ npm run typecheck && npm run lint && npm run build   # all clean
```

## S03-02 - CSV bulk import (2.00d)

**AC (verbatim):** A 100-row CSV imports with a preview step and no silent failures.

**Status: DONE (2026-10-25).** `src/knowledge/csv.ts` is a dependency-free parser/preview; `src/knowledge/import.ts` commits through S03-01's `createArticle`/`editArticle` inside the caller's transaction. No schema change, no HTTP route, no `requireRole` (S04-01 owns the guard).

- [x] `previewArticleCsv(text)` is pure (no DB): UTF-8 optional BOM, `\n`/`\r\n`, RFC 4180 quoting with escaped quotes and embedded newlines; blank and whitespace-only lines are skipped. Header is exactly `topic_key,title,language,body`, case-insensitive after trim, fixed order. Structural failures (empty/header-only file, bad header, unclosed quote, bare CR outside quotes, stray quote in an unquoted field, >500 rows, >10 MiB input) throw `CsvParseError` with row/field where available. Row-level failures (wrong column count, invalid fields, duplicate `topic_key`) are returned in `CsvPreview.errors`.
- [x] The 500-row cap is enforced during parsing (it stops at the 501st data record), and a 10 MiB byte ceiling bounds the request before the parser allocates records.
- [x] Row validation delegates to S03-01's exported validators (`validateTopicKey`, `validateTitle`, `validateBody`, `validateLanguage`, `validateSourceId`). A row reports every bad field, not just the first; `body` may contain newlines but not be empty; `language` is `es|en`; a later duplicate `topic_key` is a row error. Invalid topics do not pollute duplicate detection. `CsvPreview` returns only valid drafts plus `{total, valid, invalid}`.
- [x] `importArticleCsv(client, context, actor, text)` verifies the session is inside a `withTenant` transaction matching the supplied context, revalidates, then looks up each property-scope topic and calls `editArticle` for an existing article or `createArticle` for a new one. It returns `{imported, created, updated, unchanged, preview}`; validation failures throw `CsvImportValidationError` carrying the full preview before any write.
- [x] All-or-nothing is the caller transaction: a DB failure mid-file rolls back every prior row (articles, versions, audit). No duplicate articles on re-import; an identical row is `unchanged` and writes no version or audit row, while `updated` counts only rows that actually wrote.
- [x] Tests: `tests/knowledge/csv.test.ts` (18: 100-row preview, BOM/CRLF/header case, quoted comma/quote/newline, all-field errors, duplicate topic, invalid-topic deduplication, wrong columns, blank/whitespace lines, empty fields, header-only, empty/malformed headers, unclosed quote, bare CR, stray quote, 500-row cap, byte ceiling, empty body/language, determinism). `tests/db/import.db.test.ts` (12: 100 rows -> 100 articles + 100 retired versions, changed re-import -> 200 versions no duplicates, identical re-import -> 100 unchanged + zero writes, validation failure writes nothing, mixed create/update, per-tenant isolation, header-only refusal, parse-error no-write, bare-CR/whitespace handling, tenant-transaction precondition, 500/501 boundary, forced DB failure mid-file rollback). The 100-row import completed in ~2.8s in the DB suite.
- [x] No `requireRole` call: S04-01's first staff route will call `session.requireRole("knowledge", "write")` and close S02-06.

**Evidence (local, verified):**
```text
$ npm run db:test                                      # 107 passed (107), incl. 12 import
$ npm test                                             # 138 passed (138), incl. 18 CSV
$ npm run typecheck && npm run lint && npm run build   # all clean
```

## S03-03 - property_facts service (2.00d)

**AC (verbatim):** Pool hours answered by lookup, not generation.

**Status: DONE (2026-10-25, review rounds 2 and 3).** `src/knowledge/facts.ts` is the tenant-scoped fact service: create/update/list/get, verify with an actor, exact-key lookup of verified rows only, and contradiction listing. `db/migrations/0009_property_facts.sql` is the schema change; `src/fixtures/fixture-hotel.ts` carries `factKey` and the seed fills the new columns. No browser UI and no LLM call (S08 owns the screen, S04-01 the route). Round 1 review findings (P1 verified-write, P2 NOT VALID/charter/citation/lock/timezone/actor, P3 idempotency/index/charter) are closed below, as are round 3's two (P1: the guard refused a no-op UPDATE of a verified row, so `db:seed` and a no-change `updateFact` failed; P2: the test named "keep an untouched verification" never touched a verified row, and §6 said "always resets").

- [x] **Schema (0009, operator-approved 2026-10-25):** adds `unit` (CHECK: `text`, `time-of-day`, `hours`, `currency-amount`, `duration`, `distance`, `count`), `effective_from`, `source_article_version_id`, `verified_by`, `verified_at`; `property_facts_verified_fields` (verified ⇒ by + at + effective_from) added **`NOT VALID`** so a pre-0009 verified row cannot abort the migration; composite FK to `article_versions`; **drops** 0001's `UNIQUE (property_id, topic_key, fact_key, language)` so unverified variants can coexist, and replaces it with the partial unique `property_facts_verified_key ... WHERE verified` (one verified holder per key + effective date) plus a partial `property_facts_lookup` index ordered by `effective_from DESC, created_at DESC`. Existing rows need no backfill UPDATE; `unit` defaults to `text`.
- [x] **`verified` is defended in the database (P1):** 0002 gave `concierge_app` blanket DML, so 0009 now installs `property_facts_guard_verification()` (BEFORE INSERT OR UPDATE) — a content/citation edit drops `verified/verified_by/verified_at` for **every** role, and a `false → true` flip or a stamp **rewrite** (`verified_by`/`verified_at` changed by a non-verifier) is refused unless `current_user` is the NOLOGIN `concierge_fact_verifier`. A verified row arriving with an unchanged stamp is a no-op and passes, so a re-seed or a no-change update never fails on a verified fact (review round 3). `verify_property_fact(fact_id, actor)` is `SECURITY DEFINER` under that role: it refuses an actor who is not `app.current_user_id` or not a member of the property (`current_membership_role`), then writes the stamp. `concierge_app` keeps UPDATE only on content/citation columns; the migration owner is not left a member of the verifier role (0004/0005 rule).
- [x] **Fixture/seed:** `FixtureFact.factKey` added (`closing_time` x2, `massage_60`, `facial`, `hours`); the seed writes `fact_key`/`unit`/`effective_from`/`source_article_version_id` with `ON CONFLICT (fact_id) DO UPDATE ... WHERE` on those four fields only — an existing demo DB is upgraded in place, counts stay 5, and a re-seed whose fixture values already match writes nothing, so an operator's `verified` verdict and its stamp are untouched. Verified on a purpose-built pre-0009 demo DB (all five rows at `fact_key` = fixture id, `unit = text`, no effective date, no source version): one `db:seed` filled every field in place, count stayed 5. A legacy row that an operator had verified **does** lose that verdict on this first upgrade seed, because the seed changes its `fact_key` and `effective_from` (the one rule); such a row was never answerable by `lookupFact` (its `effective_from` was NULL), so an operator re-verifies it through `verifyFact` afterwards. The two pool rows now share `(pool.hours, closing_time, es, 2026-01-01)` with 21:00 vs 20:00: a real contradiction. Spa prices differ by `fact_key`, so they are not one.
- [x] **Lookup (AC-1/AC-2):** `FACT_LOOKUP_SQL` is one `SELECT` over `property_facts` — no write clause, no embedding column, no ranking, no provider (asserted in `tests/knowledge/facts.test.ts`). It hard-filters `verified`, exact key/language/tenant, `effective_from <= on` and orders newest-first; unverified or unknown keys return `null`, never a guess. `on` defaults to **today at the property** (`properties.time_zone` via the exported `propertyLocalDate()`; `CURRENT_DATE` only as the last-resort fallback), so a UTC session cannot publish tomorrow's hours early at a UTC-6 hotel. `on` must be a real calendar date or it is a `FactValidationError`.
- [x] **Verify (AC-3):** `verifyFact` first binds the actor to the session (`assertSessionActor`: `app.current_user_id` must equal the actor and the actor must be a member of this property → otherwise `FactActorError`), requires `effective_from`, then locks the whole key group `ORDER BY fact_id FOR UPDATE`; every value written to the audit row is read from that locked result (the earlier key read is discovery only), so a concurrent `updateFact` cannot make the trail lie. It refuses any other verified row with `FactContradictionError` (both ids + the conflicting value), writes through `verify_property_fact()`, and maps a 23505 to the same contradiction. Re-verifying an already verified row is idempotent: same `verified_at`, same `verified_by`, no second `fact.verified` row.
- [x] **Update (AC-4):** the trigger owns the rule — a content/citation change resets `verified=false`, `verified_by=NULL`, `verified_at=NULL`; an update that changes none of those fields is a no-op that keeps the verdict (and returns `verifiedReset: false`). The return reports `verifiedReset` so callers can explain the change. The D5 citation is tri-state: omitting `sourceArticleVersionId` keeps the existing link, `null` clears it, a UUID replaces it. Lookup falls back to `null` afterwards unless another row is verified.
- [x] **Contradictions:** `listContradictions` groups by `(topic_key, fact_key, language, effective_from)` with `count(distinct fact_value) > 1`, returning values, verified flags and source version ids for S04-01's queue — both verified and unverified sides.
- [x] **Tenancy (AC-4):** foreign fact ids are `FactNotFoundError` for get/update/verify (no existence leak), foreign `sourceArticleVersionId` is `FactSourceVersionNotFoundError`, and `listFacts`/`lookupFact` are RLS- plus context-scoped.
- [x] **Audit (AC-6):** vocabulary gains `fact.created` and `fact.updated` (`fact.verified` existed); detail is `{topic_key, fact_key, unit, language, effective_from}` (+ `value` for verify) — never body/content. A failed `writeAudit` throws `AuditWriteError` and the transaction rolls the fact back with it.
- [x] **Validation:** keys are lowercase dot/underscore/dash segments ≤120; value trimmed 1..500; unit from the closed CHECK; language 2-8 lowercase letters (the `es|en` article rule does not apply — the fixture uses `fr`); `effectiveFrom`/`on` are real dates (leap-day aware), future dates allowed.
- [x] **Tests:** `tests/knowledge/facts.test.ts` (17: key/value/unit/language/date validation, source-version UUID handling, whole-input normalization, lookup SQL shape with no write/embedding/provider keyword, contradiction SQL shape, unit set matching the migration's CHECK, `propertyLocalDate` at fixed instants, and `lookupFact` asking for the property date only when `on` is absent). `tests/db/facts.db.test.ts` (20: 0009 columns/NOT VALID CHECK/dropped unique/both partial indexes/guard trigger/narrowed ACL, seeded units+dates+version ids and the pool/spa key shape, null lookup before verification (incl. an unknown key), verify + contradiction refusal + lookup returns 21:00 + `verified_by/at`, effective-date window, timezone "today" at a fixed clock, the raw-SQL P1 probe (app 42501, insert-verified refused, owner refused, content edit drops the verdict, CHECK 23514 with the trigger off, no audit rows written), contradiction listing (pool yes, spa/gym no), update resets verification and lookup returns null again, EXPLAIN uses the partial lookup index, create/get/list + audit detail, citation kept when omitted/cleared on null, foreign source version refused, session-bound actor four ways, idempotent re-verify (same stamp, no duplicate audit), audit-failure rollback, cross-tenant invisibility, legacy row without `effective_from` refused, **both halves of the update rule starting from a verified row**, and **`seedDemo` twice over a verified fact** (5 facts, same stamp, no extra `fact.verified` row)). `tests/db/non-superuser.db.test.ts` migration count 8 → 9 and `concierge_fact_verifier` is not reachable from the deployed owner.

**Evidence (local, verified on a real cluster — PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm):**
```text
$ npm run db:migrate                                  # 9 applied (0009 lands)
$ npm run db:seed                                     # {"property_facts":5,...} (5 facts, new fields filled)
$ <verify the pool 21:00 via verify_property_fact>
$ npm run db:seed                                     # over a verified fact: 5 facts, still 1 verified
$ npm run db:test                                     # 127 passed (127), incl. 20 facts
$ npm test                                            # 268 passed (268), incl. 17 fact validation
$ npm run typecheck && npm run lint && npm run build   # all clean
```

**Seed-after-verify proof (review round 3):** with the demo pool 21:00 verified through `verify_property_fact()`, `npm run db:seed` completes — `{"property_facts":5,...}` — leaving 5 facts and still exactly 1 verified row with its original stamp. Guard probes on the same database: a stamp rewrite and a `verified_at` swap are refused, a raw `verified = true` on an unverified row is refused, a no-op `UPDATE ... SET fact_value = fact_value` on the verified row succeeds and keeps the stamp, and a content edit resets the verdict to false.

**Lookup / no-guess proof:** both pool facts are `verified = false` after the seed, so `lookupFact(pool.hours, closing_time, es)` → `null` (and an unknown key → `null`). After `verifyFact` on the website row it returns `{value: "21:00", unit: "time-of-day", effectiveFrom: "2026-01-01"}`; the directory row's `20:00` is refused with `FactContradictionError` naming both fact ids.

## S04-01 - Review-and-approve screen (2.00d, +1.00d for S02-06)

**AC (verbatim):** A contradictory pair is blocked until a human resolves it.

**Status: DONE (2026-10-25).** Three pieces, one contract:

1. **The service** — `src/knowledge/review.ts`: `listReviewQueue`, `approveVersion`, `rejectVersion`, `resolveContradiction`. Every function's first statement is `session.requireRole(...)`, which is what makes this the first production caller of the guard (S02-06). `db/migrations/0010_review_queue.sql` adds `article_reviews` and `fact_resolutions`, both with FORCE RLS, the `tenant` policy and `GRANT SELECT, INSERT, UPDATE TO concierge_app`.
2. **The routes** — `src/staff/http.ts` + `api/review/[...path].ts` + a branch in `src/server.ts`: `GET /api/review/queue`, `GET /api/review/contradictions`, `POST /api/review/versions/:id/approve`, `POST .../reject`, `POST /api/review/contradictions/resolve`. Order is token → tenant headers → `withStaffSession` → service guard, so an invalid token costs no database work and a denied role never reaches a query. One pooled client is checked out per request (a `Pool` must never back a `BEGIN`/`COMMIT`).
3. **The screen** — `web/` (Next.js, React 19, Tailwind, shadcn/ui), the DEC-1 decision. It calls the API through `web/app/api/review/[...path]/route.ts`, which attaches the bearer token from an HttpOnly cookie; the browser never holds the token and never talks to the API origin directly. Copy comes from `src/i18n/catalog.ts`, imported rather than duplicated.

**Why the choices, in one line each:**
- *Decisions are rows, not a column* — `0003`'s `article_versions_append_only` trigger makes a mutable `is_current`/approved column impossible, and AC-1 only asks that the approval row name a staff user. Re-deciding moves reviewer and timestamp together via `ON CONFLICT ... DO UPDATE`, so "who approved this" is never stale.
- *`fact_resolutions` exists as well as the charter's `article_reviews`* — S03-03's `listContradictions` groups on `(topic_key, fact_key, language, effective_from)` and would otherwise never empty, making "zero unresolved contradictions" unprovable. The group key is the row identity (`UNIQUE NULLS NOT DISTINCT`, PG15+, matching the `IS NOT DISTINCT FROM` grouping). `FACT_CONTRADICTIONS_SQL` gained a `NOT EXISTS` against it.
- *A resolve verifies exactly one winner and demotes nothing* — the losers stay unverified rather than being rewritten, so provenance (`source_article_version_id`) is untouched and `property_facts_verified_key` (0009) remains the backstop against two verified values.
- *An approval cannot be anonymous* — `article_reviews_decision_fields` refuses any non-pending row without a reviewer and a `decided_at`, which is what makes AC-1 a database promise and not a service promise.
- *`property_facts_tenant_key` (new unique index on `(org_id, property_id, fact_id)`)* — `0001` keyed `property_facts` on `fact_id` alone, so the composite FK a resolution needs had no target; without it a bug could file a resolution against another tenant's fact id.

**AC-1 (approval before current):** `approveVersion` writes the decision row and the `article.version_approved` audit entry in one transaction; the CHECK rejects a nameless `approved` row (proven by a raw INSERT in the denial suite, SQLSTATE 23514).

**AC-2 (a contradiction stays open until a human picks):** `resolveContradiction` re-reads `listContradictions` inside the transaction, refuses an unknown group or a winner outside it, calls `verifyFact` for the winner only, upserts `fact_resolutions`, and audits `fact.contradiction_resolved` with `entity_type = fact_group`. Repeating the call is a 404, not a silent success; the group is gone from the queue because the SQL excludes resolved groups.

**AC-3 (S02-06, denial with zero writes):** `tests/db/role-denial.db.test.ts` — owner/manager approve and the row names them; `front_desk` and `observer` get 403 `role_not_on_surface` on approve, reject **and** resolve; a stranger with a valid token gets 403 `no_membership`; a foreign property is refused; a garbage token is 401 before any query; and every one of those is bracketed by counts of `article_reviews`, `fact_resolutions`, `audit_log` and verified facts. The roles come from `memberships` (the test asserts the resolved `role_id`, driving `app.current_user_id`), never from a claim in the token.

**Evidence (local, verified on a real cluster — PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm run db:test                                      # 137 passed (137), incl. 10 role-denial
$ npm test                                             # 277 passed (277), incl. 9 staff/http
$ npm run typecheck && npm run lint && npm run build    # all clean
$ npm run web:build                                     # Next.js 15 production build, 5 routes
```

**Deploy note:** `web/` is its own npm project (`npm run web:install`, then `web:dev` / `web:build`), deployed as a Vercel project with `REVIEW_API_URL` pointing at the API deployment. The API refuses to start the review routes without auth configuration (503 on every `/api/review/*` request), which is deliberate: a misconfigured deployment fails closed.

## S04-02 - Chunking + embeddings (1.00d)

**AC (verbatim):** Every published version is chunked and embedded.

**Status: DONE (2026-10-25).** DEC-3 closed by the operator: **OpenAI `text-embedding-3-small` over plain `fetch`, no SDK**. `db/migrations/0011_article_chunks.sql` is the schema change, `src/knowledge/reembed.ts` gained `chunkAndPublish` / `backfillChunks`, `src/providers/embedding.ts` is the provider seam, and `npm run db:seed` now chunks the fixture.

**Why a second retrieval layer, in one paragraph.** `article_versions` already carries a whole-body embedding and a `tsv`; S02-05 retrieves from it. That holds while articles are short. The fixture's 19,462-character noticeboard is the counter-example: one vector for forty paragraphs dilutes against any single one, and `ts_rank` over the whole body cannot separate "pool closes at 20:00" from "spa closes at 20:00" inside the same document. The chunk is the unit a guest's question is comparable to. The whole-body vector stays: it is what S05 cites and what a version-level rerank reads.

**The decisions that shaped the code:**

- *One provider call per publish.* `promote_article_version` (0003) refuses a version whose own `embedding` is NULL, so chunks alone cannot satisfy the publish gate. `chunkAndPublish` embeds `[body, ...chunks]` in one request — position 0 is `article_versions.embedding`, the rest are ordinal-ordered chunk vectors. Two calls would let the two vectors come from providers that disagree and would double the failure surface.
- *Publish order is the AC.* read → chunk → embed everything → write chunks → promote → retire the previous version's chunks, all in the caller's transaction. A provider failure, a wrong-width vector or a refused promotion leaves the previous version current and untouched. `tests/db/chunks.db.test.ts` proves the rollback for each failure.
- *AC-1's second clause is what forces a DELETE.* "Every chunk resolves to a current version" cannot hold while v1's chunks survive v2's promotion, so `article_chunks` grants DELETE (unlike 0010's tables) and both publish paths (`chunkAndPublish`, and S02-05's `reembedAndPublish`) sweep the retired siblings. Derived data only: v1 keeps its immutable body and whole-body embedding.
- *`(article_version_id, ordinal)` is identity.* Ordinals are 0-based and contiguous; the `article_chunks_identity_immutable` trigger refuses any UPDATE that moves a chunk to another version or position, while allowing the text/vector to be rewritten (a model change is legitimate). Rewriting position would silently repoint an existing citation.
- *The provider never echoes its key.* Errors carry a status and a ≤300-character body snippet; a transport failure is re-wrapped rather than re-thrown, because a `fetch` rejection can carry the request headers in its message. Response order is restored by `index` and checked to be a permutation of `0..n-1`, so chunk N can never receive chunk M's vector.
- *`backfillChunks` + `npm run embed:all` exist because "publish" grew a second half.* A database that published before 0011 has current versions with no chunks. The script takes an explicit `--org`/`--property` (enumerating tenants would mean reading across RLS) and compares each current version's chunk COUNT against `chunkBody(body).length`, so a half-written set is repaired too, not only an empty one. `backfillChunks` refuses a retired version: chunking history would violate the invariant it is meant to restore.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm on a real cluster):**
```text
$ npm run db:migrate                                  # 11 applied (0011 lands)
$ npm run db:seed                                     # {... "article_chunks":26} - demo satisfies AC-1 with no API key
$ npm run embed:all -- --org <uuid> --property <uuid> --stub
                                                      # {"versions":3,"chunks":3} after deleting 3 versions' chunks
$ npm run db:test                                     # 152 passed (152) - incl. 15 article-chunks
$ npm test                                            # 293 passed (293) - incl. 13 provider, 48 chunking
$ npm run typecheck && npm run lint && npm run build   # all clean
```

**Seed note:** the fixture's 7 published versions are chunked with the same deterministic `stubEmbedding` the seed already uses for whole-body vectors, so a fresh demo database satisfies AC-1 without an embedding key. `--stub` on `embed:all` is the same idea and is for local/CI only: a stub vector is meaningless for real retrieval.

## S04-03 - Hybrid retrieval (2.00d)

**AC (verbatim):** Recall ≥90% on the golden set's target articles.

**Status: DONE for AC-1 and AC-2; AC-3 NOT PROVEN (blocked on golden set v2, G1).** `db/migrations/0012_retrieval_indexes.sql` and `0013_retrieval_weights.sql` are the schema changes; `src/knowledge/hybrid.ts` is the fusion engine, `src/knowledge/resolve.ts` the brand/property rule, `src/knowledge/answer.ts` the fact short-circuit, and `npm run eval:retrieval` the measurement.

**What "hybrid" means here.** Three candidate lists over `article_chunks` — lexical (`websearch_to_tsquery('simple')` + `ts_rank`), trigram (`word_similarity`), vector (`<=>` on the chunk embedding) — fused with weighted reciprocal-rank fusion, `Σ w_i / (60 + rank_i)`. RRF was chosen over summing scores because the three scales are not comparable (`ts_rank` is a small per-document float, `similarity` is 0..1, cosine distance 0..2): summing them lets whichever branch emits larger numbers win. RRF throws the magnitudes away and keeps only the order. `60` is a code constant, not a setting — it changes every ranking and no hotel can reason about it; the *weights* are the tunable part and they live in `properties.settings.retrieval_weights`.

**The decisions that shaped the code:**

- *`is_current` is a literal in all five statements.* Two whole-body statements (S02-05) and three chunk candidates. There is no `includeRetired`, no mode, no setting: `tests/db/retrieval.db.test.ts` greps both files for exactly five `av.is_current` occurrences and rejects any parameterised or boolean form. A caller cannot widen retrieval to retired history at runtime.
- *Hybrid is the default, so the old auto-detect assertions had to be rewritten, not re-pointed.* `retrieveCurrentVersions` used to pick lexical vs vector by whether an embedding was supplied. Every S02-05 assertion now names `mode: "lexical"` / `mode: "vector"`, and the hybrid behaviour is pinned in `tests/db/hybrid.db.test.ts`. Leaving the old assertions on the default would have silently changed what they tested.
- *Property over brand is a property of CONTENT, not of the ranking.* `preferProperty(hits, coverage)` receives the set of topics the property has published (one extra query, `propertyCoveredTopics`), because the case that matters is the one where the hotel's chunk does *not* score and the brand prose does. Falling back to brand there would answer "the spa closes at 20:00" over a local "19:00 on holidays". Returning nothing is the honest outcome, and S05 escalates on it. Brand content still fills every topic the property has never written.
- *`retrieval_weights` is a required settings key* (0013), defaulting to `1/1/1`, with `DROP CONSTRAINT` + `ADD CONSTRAINT` re-binding `properties_settings_valid` to the new validator. A renames-only "upgrade" does not work: a CHECK constraint binds the function OID it was parsed against. All-zero weights are rejected (they would return nothing for every question, indistinguishable from "no knowledge"); a single non-zero weight is fine, so pure lexical remains a legitimate setup.
- *Per-token trigram, not whole-string `similarity`.* A real chunk is 200-400 characters, so a perfect one-word match scores ~0.10 against the whole string and a long chunk can never win ("albcrca" vs a chunk containing "alberca"). `word_similarity(query, body)` fixes that only for a one-word query: with "alberca cierra" it demands the two words adjacent and returns ~0, so every real question would silently skip the branch. The branch therefore takes `max(word_similarity(token, body))` over the query's tokens. The explicit `>= 0.4` threshold is not index-eligible and therefore scans — accepted, and cheaper at pilot volume than a branch that silently returns nothing.
- *The lexical branch ORs its tokens instead of ANDing them.* `websearch_to_tsquery` ANDs, which is right for a search box and wrong for a chunk: "alberca cierra" requires both words in the same paragraph, so an article saying "the pool opens at 07:00" in one paragraph and "closes at 21:00" in another scores zero. Tokens are quoted before `to_tsquery` — a guest's question is not a query language.
- *Every published version has chunks on BOTH publish paths.* S02-05's `reembedAndPublish` used to set a whole-body vector and promote, leaving zero chunks — invisible while retrieval read `article_versions`, and a hole once retrieval reads chunks. It now calls the same `writeChunks` (one provider call for `[body, ...chunks]`), so AC-1 of S04-02 cannot be bypassed by choosing that route.
- *The fact short-circuit comes before retrieval.* `resolveAnswerSource` looks up a structured key (`property_facts`, exact match, verified only) and only falls back to retrieval when there is no fact. Retrieval-first would let a stale body out-vote the value an operator just signed off.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm on a real cluster):**
```text
$ npm run db:migrate                                  # 13 applied (0012, 0013 land)
$ npm run db:seed                                     # {"...","article_chunks":26}
$ npm run db:test                                     # 166 passed (166) - 18 files; +10 hybrid, +4 answer-source
$ npm test                                            # 294 passed (294)
$ npm run typecheck && npm run lint && npm run build   # all clean
$ npm run eval:retrieval -- --org <uuid> --property <uuid> --stub
   golden set: data/golden/golden-questions-v1.csv (13 scorable questions)
   NOTE: golden-questions-v2.csv is absent; AC-3 targets v2 (>= 40 questions, hotel-supplied, G1).
   recall@8 = 3/13 = 23.1% (target >= 90%)
   UNPROVEN: 13 questions is below the 40 AC-3 needs (golden set v2, G1). This run cannot certify the gate.
```

**AC-3 is not met and is not claimed.** The repository has golden set **v1** (20 rows, 13 with a `target_topic`), and v1 asks about topics the demo corpus does not carry (`transport.airport`, `room.amenities`, `checkin.hours`, `policy.pets`, …) in English, while the fixture bodies are English prose filed under Spanish topic keys. The 23.1% above is a harness check, not a retrieval measurement: with `--stub` the only cross-lingual branch (vector) is switched off, and cross-lingual matching is precisely what a real embedding provides. The eval script says so in its own output and exits non-zero (`2`) rather than printing a green number over five questions. Closing AC-3 needs the hotel's ≥40-question v2 (G1) and a corpus that covers the target topics; `--stub` runs skip the vector branch entirely, because a hash-based fake vector ranks arbitrary chunks and would quietly depress two real branches.

**Not done / next:** nothing in S04-03 itself. G1 content (golden v2 + ≥25 approved articles) is the gate for the recall number; S05-01 consumes `RetrievalHit.matchedChunk` for citation.
## S05-01 - AI service with structured output contract (2.00d)

**AC (verbatim):** Malformed output rejected server-side, never sent.

**Status: DONE (2026-10-25).** DEC-2 closed by the operator: **Google Gemini over plain `fetch`, no SDK** (same reasoning as DEC-3 — no new runtime dependency). Pinned pair `gemini-2.5-flash` / `gemini-2.5-flash-lite`, both required from the environment.

**The pipeline, in order, and why each step is where it is.** `src/ai/answer.ts`: policy → verified facts → retrieval → generate → validate → persist → emit. Policy first because "this property is not allowed to answer" must cost nothing and leave no AI trace; facts before retrieval because a verified number outranks prose (S03-03/S04-03); retrieval before generation because answering from nothing is how models invent; and validation between generation and persistence so a rejected answer never gets a row that looks like a sent one — the rejected call still gets a row, with `usage.contract_violations`, which is exactly how the parse-failure rate (S07-06) is computed.

**The decisions that shaped the code:**

- *The validator is hand-written and is the AC.* `parseAiOutput` rejects unknown and missing fields, an undefined decision, an answer with no citations, a citation the retrieval did not return, a non-UUID or empty quote, a confidence outside 0..1, an unknown `reason_code`, prose attached to a non-answer, and topic keys that were not retrieved. It reports **every** violation in one error, because "invalid output" with no field name is unoperable at 2am. Provider-native JSON mode is asked for as well, but it is not trusted: `responseSchema` constrains generation, `parseAiOutput` is the control.
- *Two vocabularies, one mapping.* Appendix B says `answer | needs_human | no_answer`; `ai_runs.decision` (0001) says `answer | escalate | no_answer`. The model never sees the table's word — it does not get to decide whether an escalation is a handoff, a draft or a refusal — and `toRunDecision` is the only place the mapping happens.
- *No `ai_runs` row for a fact answer, deliberately.* `ai_runs` means "a model was invoked". A verified fact (S03-03) writes none, and the `ai_answer_sent` event carries `source: "fact"` instead. Counting a deterministic lookup as a model call would make every per-model number meaningless.
- *The retrieve-gate is "nothing was retrieved", not a score threshold.* RRF scores are rank-derived (`Σ w/(60+rank)`), so an absolute cutoff invented today would be a number with no evidence behind it. Calibration is S06-03's job, where the golden set can measure it. Until then a query with no lexical or trigram match is the honest trigger.
- *Policy causes are evaluated individually, not through `escalationDecision`.* The pipeline has to report WHICH rule blocked (`mode_human_only` vs `after_hours` vs `topic_disabled`) and classification may not have produced a topic key yet, so `escalationDecision`'s single boolean would lose information the operator needs.
- *The fallback is a model choice, the mechanism lives once.* `withResilience`: 8s/3s timeouts enforced on the caller side too (an adapter that ignores `timeoutMs` must not hold a guest's request open), two jittered retries on 429/5xx only (a 400 is our bug and will stay our bug), then a real 60s circuit that SKIPS the primary rather than paying the retry budget again, then `AiUnavailableError` → the outage path (S07-05), never a 500.
- *Gemini's schema subset is translated, not assumed.* `type: ["string","null"]` → `{type:"string", nullable:true}`, nulls dropped from `enum`, nullable fields dropped from `required`. The adapter returns TEXT; `parseAiOutput` remains the only validator, so a vendor that degrades its schema fails in one place.
- *Errors cannot carry the key.* The adapter sends `x-goog-api-key` and scrubs that value from every string that can reach a log or an exception — a gateway that echoes request headers was leaking it into `AiProviderError.message` before that fix.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm, stub provider — no key, no network):**
```text
$ npm run db:test    # 19 files / 174 passed - incl. 8 ai-runs cases
$ npm test           # 333 passed - incl. 16 contract, 8 transport, 11 gemini
$ npm run typecheck && npm run lint && npm run build   # clean
```

**Not in this item, by charter:** the guardrail pass (S05-02), the eval harness (S06-03), the conversation state machine (S06-02). **Topic classification does not exist yet**: the caller may pass `topicKey` (golden-set harness, or a future classifier); when it is absent, topic-scoped policy cannot be evaluated and is skipped — stated in the code, not silently assumed to pass.
## S05-03 - AI runs, citations and logging (1.00d)

**AC (verbatim):** Any historical answer reconstructable from the database.

**Status: DONE (2026-10-25).** `db/migrations/0014_ai_runs_indexes.sql`, `src/ai/history.ts::reconstructAnswer`, and — from S05-01, which landed the write side — `src/ai/runs.ts` + `src/ai/answer.ts`.

**Why this works at all, and why it would not have without two earlier decisions.** Reconstruction reads `ai_runs → citations → article_versions`. It is exact because 0003 makes a version immutable (editing an article adds a version) and D5 makes a citation point at a version rather than an article. Had citations pointed at `knowledge_articles`, "what did the bot cite last March" would return today's text — the single most misleading answer a support tool can give. The test proves it: v1 is cited, v2 is published, and the reconstruction still returns v1's body with `isCurrent: false`.

**The decisions that shaped the code:**

- *The migration number was rebased.* The charter calculated `0013_ai_runs_indexes.sql`; 0013 is S04-03's `retrieval_weights`, and the charter itself said to rebase on whatever merged first. It is `0014`, and the header says so.
- *Both indexes lead with the tenant columns.* Under FORCE RLS every query carries `org_id`/`property_id`, so `ai_runs (property_id, created_at DESC)` and `citations (org_id, property_id, ai_run_id)` are the shapes the planner can actually use for "this property's last 50 answers" and for one answer's citations.
- *`usage` gets a shape, not a type.* `jsonb` accepts anything; a caller writing an array is writing something no reader can read as a map, so 0014 adds `CHECK (jsonb_typeof(usage) = 'object')` and the test pins the 23514.
- *A foreign or unknown `ai_run_id` is `AiRunNotFoundError`, never an empty object.* An empty citation list reads like "the model cited nothing", which is a different (and alarming) fact. RLS already hides other tenants' rows; the error maps "0 rows" to one honest answer.
- *The verbatim model `quote` is NOT reconstructable, and this is recorded rather than papered over.* 0001's `citations` has no quote column and the charter puts schema changes to those tables out of scope. AC-1 asks for "citations and cited article_version bodies" — both are here. If dispute resolution ever needs the quote it belongs in a real column, as a migration.
- *Write-side rules live in S05-01's modules, not a parallel logger.* `recordAiRun`/`recordCitations` run inside the caller's transaction, so a rolled-back turn leaves no `ai_runs` row claiming an answer that was never sent.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm run db:test    # 20 files / 180 passed - incl. 6 ai-history cases
$ npm test           # 333 passed
$ npm run typecheck && npm run lint && npm run build   # clean
```

**Not done, by charter:** nothing in this item. S10-01 will instrument the event writer further; S08-02 renders this reconstruction in the staff UI.

## S05-02 - Guardrail layer (2.50d)

**AC (verbatim AC-1):** Every `decision=answer` has ≥1 citation in the retrieved set and every quote is entailed by its cited chunk.
**AC (verbatim AC-2):** Banned content (prices, availability, 'confirmed', 'on the way') and policy/sensitive topics escalate with a `reason_code`.
**AC (verbatim AC-3):** False-answer ≤2%, correct-or-correct-escalation ≥95% (G2).

**Status: DONE for AC-1 and AC-2 (2026-10-25). AC-3 is NOT proven and is not claimed** — it is a measurement, and the instrument (golden set v2 with 25 articles + `npm run eval`, S06-03) does not exist yet. Guardrail *code* is complete; the G2 *number* is S06-03's to produce. This gap is stated in the charter and in the workbook row.

**The gate, and where each check sits.** `src/ai/answer.ts`: policy (`policy.ts`) → **sensitive** (`sensitive.ts`) → verified fact (S03-03) → retrieval → **contradiction** → empty-retrieval gate → prompt → `parseAiOutput` (S05-01) → **`verifyAnswer`** (`guard.ts`) → persist. The two new gates are deliberately on opposite sides of the model: the sensitive gate runs *before* retrieval and generation, so the expensive, inventable part never happens for a refund or a medical question; the verification gate runs *after* generation and *before* persistence, so a rejected answer never gets a row that looks sent.

**The decisions that shaped the code:**

- *Shape check and meaning check are different files, on purpose.* `parseAiOutput` already rejects a malformed JSON, an answer with no citations and a citation id the retrieval did not return. `verifyAnswer` re-checks those (one `Map` lookup; a guard must be safe to call on any `AiOutput`) and adds the check that actually matters: **the quoted words must appear in the cited version**. A model that cites a real version and quotes a sentence that exists nowhere is manufacturing a source — the worst failure this product can have.
- *Entailment is normalised substring containment, and the header says so.* Case, accents, punctuation, ellipsis and whitespace are folded before containment, because "cierra a las 20:00" against "cierra a las 20:00." is not a fabrication. It is checked against the matched chunk **and** the full body, because a quote may span a chunk boundary. This cannot prove semantic entailment — S12's manual audit is the check for that — but no model can argue its way past a substring.
- *Tuning that only a test could have found.* `en_route` originally required "on the way now"; the bare phrase is the one a model actually writes. Sensitive matching runs on an **accent-stripped, punctuation→space** haystack, so `¿Hay recepción?` matches `recepcion` — the first version matched `" term "` and failed on the question mark, which is exactly how it would have failed on a real guest message.
- *A non-answer is not "verified".* `verifyAnswer` returns `not_an_answer` for `decision != answer`. S05-01 already escalates those; marking them as a guardrail pass would have made the audit log lie about what the guard did.
- *Banned content escalates, it is never edited outward.* A price the model invented is not an incidental phrase — the rest of the sentence was built on the same invention, so `banned_content:<ids>` → `policy_block` → human. Card numbers get a `[redacted]` excerpt in `violations` and never reach the log whole (`src/security/pii.ts`, Luhn-checked, shared with S11-03).
- *The confidence floor is a parameter defaulting to 0.* A floor invented here would be a number with no evidence behind it. S06-03 calibrates it against the golden set; S07-04 can pass a property's own. Until then the gate is silent on confidence, and the code says why.
- *One policy gate, consumed not implemented.* `policyGate` returns `{allow, reasonCode, detail, topicUnclassified}` and adds the two spend caps to S05-01's mode/after-hours/topic causes. The counter belongs to S07-04 (it has to survive across requests, and `policy.ts` is pure), so `spendTodayUsd` is an input: **omitted means "no budget information" and allows; present-and-over refuses**. `topicUnclassified: true` records that topic rules were skipped — the topic classifier still does not exist, and pretending an unclassified question passed a topic check would be the same class of lie.
- *Contradiction beats both answers.* If `listContradictions` reports a verified/unverified disagreement for the resolved topic, the turn escalates with `contradiction:<topic>.<fact>` rather than picking a side. Only a *value* disagreement escalates; two articles merely mentioning the same fact do not.
- *Every rejection leaves a trace.* `escalate`/`no_answer` write an `ai_runs` row (with `usage.guard`, `usage.violations` capped at 5) and, on the two no-answer paths, a `knowledge_gaps` row (`question`, `language`, `status: open`) — the gap list is what an operator works from, and it is now fed by the guard.
- *One pre-existing flake surfaced under the full db run and is fixed here.* `tests/db/hybrid.db.test.ts`'s `is_current` case also asserted that `"gimnasio abre"` ranks the freshly published version first. Both articles match that query in the lexical and trigram branches, so the fused score ties to the last digit and the winner was decided by a random UUID — it passed in isolation and failed whenever another suite had run first. The assertion now queries a token that exists only in v2 (`"enero"`), which tests `is_current` and not tie-breaking. Nothing in `src/` changed.
- *The guest sees a catalogue string, never model text.* Every non-answer outcome carries `guestMessage = t("guest.idontknow", lang)` in the **message's** language. The db test asserts it through the catalogue (`t("guest.idontknow", "es")`) rather than a copied English literal — the first version of that assertion hardcoded English and failed for the right reason.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm, stub provider — no key, no network):**
```text
$ npm test           # 25 files / 356 passed - incl. 23 guardrail cases
$ npm run db:test    # 20 files / 184 passed - incl. 12 ai-runs cases (4 new)
$ npm run typecheck && npm run lint && npm run build   # clean
```
The four new db cases are end-to-end, not unit: a fabricated quote → `escalate` / `quote_not_in_cited_version` with `usage.guard` set and **zero** citation rows; an invented price → `policy_block` / `banned_content:currency_amount` with the price absent from the guest's text; a refund question → `sensitive_topic` / `sensitive:money_and_refunds` with `provider.requests.length === 0` and **no** `ai_runs` row (the model was never asked); and `"xyzzyqqq"` → `no_answer` plus an open `knowledge_gaps` row.

**Not done, by charter:** the 50/week manual accuracy audit (S12), golden-set content (G1), and therefore **AC-3**. Also not done, and named rather than hidden: semantic entailment (substring containment only), a topic classifier (topic-scoped policy stays unevaluated until one exists), and the spend counter itself (S07-04). The verbatim `quote` still has no `citations` column (S05-03's recorded gap), so verification is reproducible only from the answer text and version bodies, not from the quote alone.

## S06-01 - Public property-scoped web chat (2.00d)

**AC (verbatim):** A stranger holds a full conversation on staging.

- **AC-1** `GET /c/:propertySlug` serves a working chat; `POST /api/chat/messages` persists inbound + outbound `messages`.
- **AC-2** Tenant comes from the URL slug only — never from a request body.
- **AC-3** First message shows `guest.ai_disclosure` and a route to a human (S07-02).

**Status: DONE for AC-1, AC-2 and AC-3 as a working surface (2026-10-25); the "on staging" half of AC-1 is NOT verified from this environment** — there is no deployed target reachable here, so the evidence below is a real HTTP round trip against a locally booted server plus the CI `preview`/`web-build` jobs. Treat the deploy as the remaining operator step, not as something the code has yet proven.

**Where the pieces are.** `db/migrations/0015_guest_chat.sql` (the lookup role), `src/guest/{session,cookie,service,http,runtime}.ts` (tenant resolution, ticket, turn, wire, wiring), `web/app/c/[slug]/page.tsx` (the page), `web/components/guest-chat.tsx` (the client), `web/app/api/chat/[...path]/route.ts` (the proxy that carries the cookie both ways).

**The decisions that shaped the code:**

- *Tenant resolution is a role switch, not a query.* `properties` is FORCE-RLS, so neither the app role nor a SECURITY DEFINER helper owned by the table owner can read a row without tenant GUCs — FORCE applies to the owner too, and BYPASSRLS needs a superuser Neon does not give us. So 0015 creates `concierge_public`: NOLOGIN, no grants on any tenant table, **column-level** SELECT on six public columns of `properties`, and a policy whose only row is the one matching `app.property_slug`. The request switches DOWN for exactly one SELECT, then UP to `concierge_app` with the GUCs taken from the row it just read. The test pins all three limits: another slug is invisible, `settings` is a 42501, `messages` is a 42501, and no slug means no rows at all.
- *A bad slug is a 404, never a 400.* Distinguishing "malformed" from "unknown" tells a stranger which strings are worth guessing. Both land on `UnknownPropertyError`.
- *The forged-tenant test writes rather than reads.* `POST`ing with a foreign `orgId`/`propertyId`/`conversationId` in the body lands rows in the slug's property and leaves the other property's message count unchanged. The API never reads those fields — ignoring them is stronger than rejecting them, because a rejection is also information.
- *The cookie is signed, scoped and dull.* `base64url(claims).base64url(HMAC-SHA256)` behind `HttpOnly`, `SameSite=Lax`, `Secure` derived from the request scheme (not `APP_ENV`), 30 days. Claims: identity, conversation, **property** — a ticket harvested on hotel A is inert on hotel B (tested), and a guest who edits it gets a new conversation rather than someone else's.
- *`clock_timestamp()`, not the column default, for `messages.created_at`.* Both messages of a turn are written in one transaction, and `now()` is the transaction's start time — inbound and outbound tied to the microsecond and "order by created_at" fell through to a random UUID. The transcript test caught it; the fix is one column reference, and the reason is in the code.
- *The handoff button sends a message.* "Talk to a person" posts the catalogue string (`guest.talk_to_person`), which S05-02's classifier escalates as `guest_asked_human`. The handoff therefore lives in the same transcript the staff inbox will read (S08) instead of vanishing into a tooltip. A test asserts the reason code and that the guest sees the catalogue string, not model text.
- *The guest page no longer inherits staff chrome.* The review/session pages moved into an `app/(staff)/` route group (URLs unchanged) so `/c/:slug` does not render a "Review queue" header or a staff language chip.
- *The page 404s on the server.* The slug is resolved in the server component, so an unknown property is a real 404 rather than a spinner that never resolves.
- *A failed embedding is not a failed answer.* If the optional embedding call fails, the turn continues on lexical + trigram retrieval instead of escalating — worse retrieval, not a broken guest.
- *The outage path persists too.* Both providers down → the turn still writes an outbound message (`guest.unavailable`) and a `messages` pair; the guest never sees a 500 and the transcript never has a hole.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm, stub provider — no key, no network):**
```text
$ npm test             # 27 files / 374 passed - incl. 18 guest checks (cookie + HTTP seam)
$ npm run db:test      # 22 files / 195 passed - incl. 9 guest-chat + 2 guest-chat-over-HTTP
$ npm run web:build    # Next 15.5 builds /c/[slug] and /api/chat/[...path]
$ npm run typecheck && npm run lint && npm run build   # clean
```
The HTTP suite boots a real `http.createServer` around `handleGuestRequest`, posts two turns through `fetch`, keeps only the `Set-Cookie` value the browser would keep, and replays a four-message transcript from it — which is the closest thing to "a stranger holds a conversation" that can be executed here.

**Not done, by charter:** the staff inbox (S08), the WhatsApp adapter (WA track), rate limiting and spend caps enforcement (S07-04 — `policyGate` consumes the counters but nothing produces them yet), and the S07-02 handoff *UI* (this item ships the route to a human as a classified message, which is what S07-02 will build on). Also recorded: `concierge_public` could in principle call `provision_user`, because SECURITY DEFINER functions still carry PostgreSQL's default `EXECUTE` to PUBLIC and only the function's owner may revoke it — that belongs in a dedicated hardening item, not in a silent ACL change here.

## S06-02 - Conversation state machine (1.50d)

**AC (verbatim):** Illegal transitions impossible at the database level.

- **AC-1** A `BEFORE UPDATE` trigger rejects any state transition not in the allowed table.
- **AC-2** `takeover` is atomic: AI cannot reply after a staff takeover (feeds S08-03).

**Status: DONE (2026-10-25).** `db/migrations/0016_conversation_state.sql` (the column, the guard function, the trigger, the queue index), `src/conversation/state.ts` (the same matrix in TypeScript, `lockState`, `transition`, `takeover`, `assertModelMaySpeak`), and the guest turn in `src/guest/service.ts` now runs under the conversation's row lock.

**The decisions that shaped the code:**

- *The charter's migration number was wrong and was rebased.* It calculated `0014_conversation_state.sql`; 0014/0015 were taken by S05-03 and S06-01, so this is **0016**. The charter says to rebase; the header says what happened.
- *A trigger, not a CHECK and not a service.* A CHECK cannot see OLD, and "which transitions are legal" is by definition a statement about a pair. A service cannot see raw SQL, a migration, a background job or a future caller that never read this file. The trigger is the authority; the TypeScript matrix exists so a caller gets a typed error before the round trip, and `tests/db/conversation-state.db.test.ts` walks **every pair of the 4×4 grid** through the trigger so the two copies cannot drift.
- *`BEFORE UPDATE OF ai_state`, not `BEFORE UPDATE`.* The hot path on `conversations` is `last_activity_at`; a write that cannot change the state must not pay for, or risk, a trigger that is not about it. A same-state write is explicitly a no-op — other services will write the column back.
- *`ai_state` is a second axis, not a replacement for `status`.* `status` is the thread being open or closed; `ai_state` is who is expected to speak next. Containment (the north star) is conversations with zero staff messages, and a takeover the model can talk over afterwards was never a takeover.
- *Atomicity is the row lock, not a flag.* `takeover` and the model's writer both do `SELECT … FOR UPDATE` on the conversation row inside the transaction that does their other work. Either the takeover commits first and the turn's re-read sees `awaiting_staff` (so the model stays silent), or the turn commits first and the takeover applies to the next message. The test proves the wait: a takeover issued while another transaction holds the lock has not completed after 150 ms, and completes exactly when that transaction commits.
- *The lock is held across the model call, and that cost is deliberate.* The turn takes the row lock before retrieving and keeps it until COMMIT, so a takeover that arrives mid-generation waits up to the provider timeout (8 s) instead of racing. The alternative — lock, generate, re-lock, re-check — leaves a window where the model answers after the human took over, which is the exact bug AC-2 exists to prevent. If the wait ever becomes a complaint, the fix is a shorter generation timeout, not a weaker lock.
- *A model that is no longer allowed to speak still answers the guest.* When a turn arrives for an `awaiting_staff` conversation, the pipeline is skipped entirely (the provider is asserted to receive **zero** requests), the guest's message is recorded, and the reply is `guest.staff_reply_pending` — "a member of our team has this conversation and will reply here shortly". Silence would look like a broken bot; a model answer would be the exact bug AC-2 exists to prevent.
- *A `resolved` conversation is not a dead end.* `resolved → awaiting_ai` is legal, so a guest who writes again reopens the thread instead of talking into a void. `resolved → idle` and `resolved → awaiting_staff` are not legal, because both would discard the fact that it was concluded without a human.
- *The takeover writes its own record.* `handoff_reasons` (reason code + detail) and a `human_takeover` event are written in the same transaction as the state change, so there is no state where a conversation looks owned by a human and nothing says why. A second takeover of an already-owned conversation is idempotent: no second reason row, no second event.
- *The trigger cannot leak across tenants.* It reads only OLD and NEW of the row being updated, and the service statements are scoped by `(org_id, property_id, conversation_id)`; the trigger runs with the caller's privileges, so RLS still applies to the row it can see.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm test             # 28 files / 381 passed - incl. 7 state-matrix unit cases
$ npm run db:test      # 23 files / 204 passed - incl. 9 conversation-state cases
$ npm run web:build    # guest client compiles with the new `handoff` decision
$ npm run typecheck && npm run lint && npm run build   # clean
```
The db suite walks 8 legal and 4 illegal edges (plus 4 no-ops) through raw SQL, asserts the row is unchanged after a refusal, and drives the guest path end-to-end after a takeover.

**Not done, by charter:** the inbox UI that produces takeovers in practice (S08-01), the AI↔staff hand-back UI (S08-03), and the service-request status machine (S09-01). Recorded for S08: `takeover()` accepts no actor yet — there is no staff identity on the conversation path until S08-01 supplies one, so `handoff_reasons` records *why* but not *who*.

## S06-03 - Evaluation harness + CI job (1.50d)

**AC (verbatim):** G2 passes on the fixture property; runs on every prompt change.

- **AC-1** `npm run eval` loads the golden CSV, runs every question through the real pipeline with an injectable provider, and scores four ways.
- **AC-2** CI fails on regression: false-answer >2% or correct-or-escalation <95%.
- **AC-3** Nightly canary against the live property (config, no secrets in logs).

**Status: HARNESS + CI DONE; the G2 number is measured and it is red.** `scripts/eval.ts`, `src/eval/harness.ts`, `src/eval/thresholds.ts`, `src/eval/fake-provider.ts`, `tests/eval/*`, `data/golden/eval-baseline.json`, `.github/workflows/eval.yml`.

**The first honest measurement, on the demo fixture and golden v1:**

```text
$ npm run eval
20 questions (13 answer-expected / 7 escalation-expected) — below the 50 the 2.0% cap needs
| false answer                  | 25.0% (5/20)  | ≤2.0%  | FAIL |
| correct or correctly escalated| 40.0% (8/20)  | ≥95.0% | FAIL |
| correct escalation            | 100.0% (7/7)  | ≥90.0% | pass |
| needless escalation           | 53.8% (7/13)  | ≤20.0% | FAIL |
retrieval: the target topic reached the answer for 1/13 answerable questions (7.7%)
regression gate: pass (baseline data/golden/eval-baseline.json)
```

**The measurement found two real defects on its first run, and both are fixed here:**

1. **Three sensitive-topic misses.** "Quiero cancelar y que me devuelvan el dinero", "Creo que mi tarjeta se quedó cobrada dos veces" and "¿Pueden reservarme una mesa...?" all reached the model and were *answered*. The S05-02 keyword list held `devolucion` and `cobraron` but not `devolver`/`devuelvan`, and `reservar` but not `reservarme` — Spanish inflects by suffix, and a whole-word match cannot see that. `src/ai/sensitive.ts` now carries `stems` (`devolv`, `devuelv`, `cobr`, `reembols`, `factur`, `charg`, `reserv`, `cancel`, `disponib`), matched inside a word, and `tests/ai/guard.test.ts` pins the four phrasings that failed. This is exactly the "no silent fallbacks" rule: the harness named the reason, it did not just lower a score.
2. **Five answers to the wrong question.** "What time is breakfast served?" was answered from the gym article; "¿A qué hora es el check-in?" from the quiet-hours policy; "Is the pool heated in winter?" from the gym. Every one of them **passed** `verifyAnswer`: the citation was real, the quote was verbatim, there was no banned content. Citation verification proves a quote exists in the article it names; it cannot prove the article was about the guest's question. The harness scores the answer's `topic_keys_used` against the golden row's `target_topic`, so those are `false_answer` — with `offTopic: { target, answered }` recorded, so the report says "answered from policy.quiet — not checkin.hours" instead of just counting.

**What the red number is actually saying.** Only 1 of 13 answerable questions had its target topic retrieved: the demo fixture has seven adversarial articles (`dining.menu`, `policy.quiet`, `pool.hours`, `spa.services`, `gym.hours`, `policy.parking`) while golden v1 asks about pets, breakfast, wifi, check-in, transfers, extra beds and parking. So most of the red is **corpus**, not code — the harness is measuring the G1 content gap, which is the correct thing to measure, and it now says so in the report rather than leaving a reader to guess.

**The decisions that shaped the code:**

- *Two gates, because only one of them can be honest today.* The **absolute** gate (`evaluateGate`, plan Appendix D) needs a golden set that covers the property's articles; it is implemented and boundary-tested but takes `--enforce` to fail a build. The **regression** gate (`compareToBaseline`) is armed now, against `data/golden/eval-baseline.json`, and it is what CI actually blocks on: "did this change make it worse" is answerable from any deterministic set. Neither is allowed to stand in for the other, and the runbook prints which is which on every run.
- *The 2% cap cannot be expressed on 20 questions.* One row is worth 5%. `thresholds.ts::MIN_QUESTIONS_FOR_GATE = 50` exists so the report says "below the 50 the 2% cap needs" instead of pretending 0/20 is a passing rate; `armed` is part of the verdict.
- *A fake provider, and it is the right choice for CI.* `createGroundedProvider()` reads the prompt the pipeline actually built (same articles, same ids, same schema), and answers by quoting the sentence that shares the most content words with the question. It is deterministic, keyless, free, and network-free, so a red check on a PR is always something the author can fix. It is **not** a model-quality claim: it is the best case reachable from that retrieval, so a low score here is a retrieval or guardrail finding.
- *The fake says `no_answer` when no article addresses the question* — quoting an unrelated sentence because it is the only one available is the exact behaviour the guardrail exists to stop, and a fake that faked it would be measuring itself.
- *Live model quality is the nightly canary, in its own workflow.* `.github/workflows/eval.yml` has a `canary` job that only runs on `schedule`/`workflow_dispatch` with `GEMINI_API_KEY`. A vendor outage must not be able to block a pull request for a reason the author cannot fix, and an LLM key must not exist in PR CI at all. The PR job has no key.
- *A provider outage always exits 2, enforced or not.* "0% false answers" measured while the model was unreachable is a lie with a nice table.
- *`set -o pipefail` in the workflow.* Without it `npm run eval | tee report.md` swallows the gate's exit code and the job is green on a failure.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm test        # 30 files / 403 passed (17 harness + 5 fake-provider cases new)
$ npm run db:test # 23 files / 204 passed
$ npm run eval    # four scores + 12 named misses + retrieval diagnostic; regression gate pass
$ npm run typecheck && npm run lint && npm run web:build   # clean
```

**Not done, by design or by dependency:** G2 as a *pass* (needs G1: golden v2 and 25 current articles — the number stays red until then, and S05-02 AC-3 stays unmeasurable until it does); the nightly canary's first observed run (needs `GEMINI_API_KEY` as a repo secret — operator work, like S06-01's staging deploy); `--enforce` in CI (deliberately off until the corpus can pass it — switching it on today would make every PR red for a reason no author can fix, which is how a gate gets deleted).

## S07-02 - AI disclosure + 'talk to a person' (0.50d)

**AC (verbatim):** A human is reachable in one tap from any state.

- **AC-1** First AI reply contains `guest.ai_disclosure` (ES+EN from the catalogue).
- **AC-2** One tap posts a handoff that works from `idle`, `awaiting_ai`, `awaiting_staff` and `resolved`.

**Status: DONE (2026-10-25).** `POST /api/chat/handoff` → `postGuestHandoff` (`src/guest/service.ts`) → `takeover()`; migration `0017_handoff_from_resolved.sql`; the button in `web/components/guest-chat.tsx` now calls that route instead of sending a message.

**The decisions that shaped the code:**

- *The button stopped being a message.* S06-01 made "talk to a person" send the catalogue sentence, which the sensitive-topic classifier escalates. That was real, but it was not *one tap from any state*: on `awaiting_staff` it was answered with "a member of our team has this" **without recording that the guest asked for a human or opening a request**, and on `resolved` it went to the model. A guest's only route to a person must not depend on the provider, the guardrail, or the state of the thread. The handoff route takes the conversation row lock, takes the conversation over (state + `handoff_reasons` + `human_takeover` in one transaction), and answers with catalogue copy. No provider is constructed on that path; the test asserts **zero** provider calls, not merely "it did not throw".
- *`resolved -> awaiting_staff` is now legal, and 0016 said it was not.* 0016 refused the edge because resolving is a conclusion. S07-02's AC is the better rule: if a guest taps "talk to a person" on a concluded thread, refusing because the row says `resolved` disables the one control that exists to protect them, at the moment the bot has already given up. Nothing is discarded — `status`, the transcript and the events all keep the history, and `handoff_reasons` gains the reason the reopening happened. Routing through `awaiting_ai` to reach `awaiting_staff` would have claimed a model was answering when none was, so the matrix widened instead. `resolved -> idle` stays illegal: asking for a human must never hand the thread back to the bot.
- *One open request per conversation.* A second tap reuses the open `service_requests` row and does not re-emit `request_created`; `takeover()` is already idempotent for state and reason. A guest who taps twice has one problem, and a human should see one row. Partial index `service_requests_open_by_conversation` makes that lookup cheap on the table S09-01 will make the busiest.
- *`handoff_reasons.reason_code` is now a closed vocabulary* (Appendix B + `ai_unavailable`), `NOT VALID` on purpose: it constrains every new write immediately and tolerates rows written before the vocabulary existed. Extending it is a deliberate one-line migration — which is the point, per S05-02's "a code nobody can alert on is a code nobody will read". The isolation fixture was writing an invented code (`refresh_needed`) and now uses a real one; the constraint caught that on its first run.
- *The disclosure is prepended to the first outbound message and stored with it*, so the transcript staff read (S08) is the text the guest read, and no client can drop it. It is sent once, not on every bubble: repeating it trains guests to ignore it, and the page keeps it in the header anyway. "First" is decided by a query under the conversation's row lock (`isFirstReply`), not by `conversation.created` — a guest can tap "talk to a person" before typing, and that conversation already exists with no messages in it.
- *A stranger who taps before typing gets a conversation.* The route creates the identity and the conversation, then the handoff, so the state with no thread at all is covered by "from any state" too. The cookie round-trips, so tapping and then typing continues the same thread (asserted).
- *The acknowledgement is `author_role = 'ai'`.* The schema allows guest/ai/staff. It is a system message; `ai` is the honest label of the three (the guest did not write it, and no staff member typed it), and the disclosure on it makes that literal.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm test        # 30 files / 403 passed
$ npm run db:test # 24 files / 212 passed (8 new handoff cases; the 17-migration chain applies)
$ npm run eval    # unchanged: same four scores, regression gate pass
$ npm run typecheck && npm run lint && npm run web:build   # clean
```

**Not done, by charter:** staff inbox rendering (S08-01) — the request row exists and `human_takeover` fires, but nothing displays it yet; notification delivery (S09-05) — `service_requests` is written, email is not sent. `takeover()` still records *why* but not *who* (no staff identity on this path until S08-01).

## S07-03 - Request capture + honest acknowledgement (1.00d)

**AC (verbatim):** No code path can claim a request is fulfilled.

- **AC-1** A request creates `service_requests` + `knowledge_gaps` (for no-answer) in the same transaction as the acknowledgement message.
- **AC-2** A banned-phrase test scans every outbound template for fulfilment claims.

**Status: DONE (2026-10-25).** `src/requests/capture.ts`, `src/requests/honesty.ts`, `db/migrations/0018_request_capture.sql`, `tests/requests/honesty.test.ts`, `tests/db/request-capture.db.test.ts`.

**The bug this item actually closed.** `guest.idontknow` said *"I've asked the front desk to reply directly"* and `guest.unavailable` said *"I've passed this to the team"* — and neither created a request. The guest was told a human had it, and no queue would ever show it: the no-answer path wrote a `knowledge_gaps` row and stopped, and an escalation wrote nothing at all. S07-02 had already made the one-tap handoff create a real `service_requests` row; this item makes **every** path that promises a human do the same, through one function.

**The decisions that shaped the code:**

- *Capture precedes the message, in the same transaction.* `captureRequest` is called **before** the acknowledgement is inserted, inside the guest turn's transaction (`withGuestSession`). If the request cannot be written, the acknowledgement rolls back with it and the guest gets an error rather than a promise no queue backs. `tests/db/request-capture.db.test.ts` proves the rollback: a failure after capture leaves **no** request, no gap and no event.
- *One open request per conversation.* A guest with three unanswered questions has one conversation a human should read, not three tasks. Later captures reuse the open row and emit no second `request_created`, so S08-01's queue counts conversations — the number an agent can act on — and retry logic cannot inflate it.
- *The knowledge gap is reused, not duplicated.* The pipeline (S05-02) already writes a gap for an empty retrieval and for the model's own `no_answer`. `captureRequest` looks for an open gap with the same question in the same conversation first; the end-to-end test asserts exactly one gap row for one missed question. A different question in the same conversation adds a second gap while keeping one request — that is the correct shape for "what content should we write?".
- *`requestTopicFor` is exhaustive over the decision type.* A new `GuestTurn["decision"]` that forgets to declare its queue topic is a **compile error** rather than a silently uncaptured request. `handoff` returns `null` there because S07-02's path already captured its request before the state change.
- *Copy changed on the escalate path, and only there.* `guest.request_ack` ("I've passed this to our team. A person will reply here…") now replaces `guest.idontknow` for escalations — a refund or an allergen question is not "I don't want to guess", it is "a person has this". `guest.idontknow` stays for the no-answer path, where "I don't want to guess" is precisely what happened. `guest.request_failed` from the charter §4 was **not** added: a failed capture rolls the turn back, so a "we couldn't log it" string would describe a state the guest can never reach. Inventing copy for an unreachable branch is worse than not having it.
- *`honesty.ts` is separate from `banned.ts`, deliberately.* `banned.ts` guards **model output** at generation time and its response is to escalate; `honesty.ts` guards **our own copy** at build time and its response is a red test. One list for both jobs would be tuned for neither.
- *The sweep covers every `guest.*` string, not a curated "outbound" list.* A list is the failure mode: the string somebody adds on a Friday is the one missing from it. The exemption is `staff.*` labels — `staff.review.resolved` is "Resuelto", the name of a state shown to staff about a row whose `status` literally is `resolved`; nothing under `staff.*` can reach a guest (`replyFor`, the disclosure, the handoff acknowledgement and the guest page all read `guest.*` only). The test also asserts it scanned at least 20 strings, because a sweep that scanned nothing would pass for the wrong reason.
- *`0018`'s trigger forbids only the impossible pairings* — `acknowledged_at` on a `new` row, `resolved_at` on anything but `resolved`. It does not require `acknowledged_at` when the status moves: that rule belongs to S09-01's transition table, which also knows *who* acknowledged. The migration stops the table from carrying a lie without getting in front of the item that owns the lifecycle.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm test        # 31 files / 408 passed (5 honesty cases, incl. the vacuity check)
$ npm run db:test # 25 files / 221 passed (9 capture cases; 18-migration chain applies)
$ npm run eval    # unchanged four scores; regression gate pass
$ npm run typecheck && npm run lint && npm run web:build   # clean
```

**Not done, by charter:** lifecycle transitions (S09-01 — a request still cannot leave `new`), email delivery (S09-05). Copy review by the content owner (W00-10) is still owed before G1 sign-off; the honesty test constrains *claims*, not tone.

## S07-04 - Abuse + cost protection (1.00d)

**AC (verbatim):** Cap trip degrades to 'a team member will reply' without an error.

- **AC-1** Rate limits per IP / conversation / property; Turnstile (or equivalent) on the first message.
- **AC-2** Daily AI spend cap from `spendCaps()`; exceeding it never produces a 5xx.

**Status: DONE (2026-10-25).** `db/migrations/0019_abuse_and_spend.sql`, `src/security/ratelimit.ts`, `src/security/botcheck.ts`, `src/ai/spend.ts`, wiring in `src/guest/service.ts` / `src/ai/answer.ts` / `src/guest/http.ts` / `src/guest/runtime.ts`, guest widget `web/components/bot-check.tsx`.

**The bug this item closed was a lie in the settings screen.** `spend_cap` has existed since S02-02 with real defaults (`daily_usd: 10`, `per_conversation_usd: 0.5`), `policyGate` has refused on it since S05-02, and **no production call ever passed the counters** — both arguments were `undefined`, which the gate documents as "no budget information ⇒ allow". A property could open settings, see a cap, and have no cap. This item supplies the numbers.

**The decisions that shaped the code:**

- *Two ceilings with different owners.* **Spend** lives in `PropertySettings` because it is the property's money and `spendCaps()` already reads it. **Rate limits** are constants in `src/security/ratelimit.ts` (20/min per IP, 10/min per conversation, 600/hour per property) because a flood ceiling a property can raise is not a ceiling — the night a script is running is exactly the night someone raises it. Changing them is a pull request, not a toggle.
- *The counters are Postgres rows, not process memory.* A per-replica counter multiplies the published limit by the number of instances and resets on deploy. The cost is one upsert per guest message — three orders of magnitude cheaper than the model call it protects — and it needs no new runtime dependency.
- *Counters are consumed inside the turn transaction.* A turn that rolls back did not happen, so charging it would lock a real guest out after a transient failure. `tests/db/abuse.db.test.ts` proves the rollback: a `checkRate` in a transaction that then throws leaves the count untouched. The same transaction boundary is what makes the spend counter trustworthy — the money is added by the turn that actually spent it.
- *The IP is hashed before it reaches the table.* `key` is `sha256(salt‖ip)` truncated to 32 hex characters. A rate-limit table is precisely the kind of "operational" table that gets exported during an incident, and an IP address is personal data in every regime this product will meet. The salt is per-deployment (`DEFAULT_IP_SALT`, rotatable in S11-03).
- *`checkRate` consumes the property bucket even when the IP bucket already refused.* The tenant-wide number is what an operator looks at during an incident; a flood that is being refused must still be visible in it.
- *The bot check is a port, and it fails closed.* Turnstile is a third-party processor (DEC-9 / W00-18), so the default is the charter's: no-op in `local`, **boot failure** in `staging`/`prod` without `TURNSTILE_SECRET` — the same shape as `GUEST_COOKIE_SECRET`, because a control that is "on if someone remembered" is off. Unreachable vendor, non-2xx, non-JSON and a missing `success` field are all *refusals*: a check that fails open is one an attacker disables by blackholing a hostname. It applies to the **first message only** — Turnstile tokens are single use, so checking every turn would reject a real guest's second message.
- *Spend is estimated, and the code says so.* The provider adapters return text, not `usageMetadata`; changing that contract from a cost-protection item would touch every adapter and test, and it is S07-06's. So `spend.ts` estimates tokens as `ceil(chars / 4)` (conservative for Spanish as well as English) and prices them from one table, **rounding up to six decimals** — a 1-token call costs `$0.000001`, not `$0`. An unknown model id is priced as the most expensive known model, because a new model appearing in configuration must not mean "free". `calls` is stored alongside `cost_usd` so the exact count survives next to the inexact money, for the invoice reconciliation that S07-06 owes.
- *The cap trip reuses S07-03's honesty path unchanged.* `policyGate` refuses → `answerMessage` returns `escalate` with `guest.request_ack` → `requestTopicFor("escalate")` = `needs_human` → `captureRequest` writes the request **before** the acknowledgement, in the same transaction. So the guest is told "a person will reply", the queue actually holds that request, and there is no 5xx anywhere on the path. `guest.team_will_reply` from the charter was **not** added: `guest.request_ack` already says exactly that, and a second key for one promise would drift.
- *HTTP is 429 and 403 with numbers attached.* `RateLimitedError` carries the bucket, the limit and `retryAfterSeconds`, which `src/guest/http.ts` turns into `retry-after`; the guest UI renders `guest.chat.rate_limited_seconds` with the actual countdown. A client told nothing retries immediately; a client told "17 seconds" waits.
- *The client address comes from the transport, never the body.* `clientIp` reads the first `x-forwarded-for` hop, then `x-real-ip`, then the socket. A client that could name its own bucket would have no limit at all — and when there is no trusted proxy, the header is caller-supplied, which is why the ip bucket is a speed bump and the **property** bucket (which cannot be forged) is the real ceiling.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm test        # 34 files / 442 passed
$ npm run db:test # 26 files / 232 passed (11 abuse cases; the 19-migration chain applies)
$ npm run db:migrate                # 19 applied
$ npm run eval    # unchanged four scores; regression gate pass
$ npm run typecheck && npm run lint && npm run web:build   # clean
```

**New standing procedure — `docs/progress.md`.** `npm run progress` (`scripts/progress.mjs`) reads column K of `docs/07-master-backlog.xlsx` and writes the report: overall and per-sprint bars, in-flight items with their recorded blocker, remaining days by block, and the delta against the previous run (read from an HTML comment at the top of the previous file, so the comparison cannot be faked by editing prose). It fails loudly on a status it does not recognise rather than silently counting it as "not started" — the workbook uses two vocabularies (`✅ Done` and an older bare `Done (...)`), both are supported, and a third would be a mistake worth stopping for. Re-running it is part of every item's close-out (`docs/ahead-charters/README.md` §6.4).

**Not done, by charter:** outage fallback (S07-05 — a provider outage is still handled by S05's `unavailable` path, not by this item's degradation); PII redaction (S11-03). **Open, and flagged:** DEC-9 / W00-18 — enabling the bot check in production sends guest IPs and browser metadata to Cloudflare, which must appear in the privacy notice and be covered by a DPA first. Until that closes, production runs with the check disabled and the rate limits as the only ceiling. **Also owed:** real token accounting and one invoice reconciliation (S07-06), a retention rule for both counter tables (S11), and the ip-hash salt joining the PII work (S11-03).
