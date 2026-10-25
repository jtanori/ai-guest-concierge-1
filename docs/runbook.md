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

**Status: PARTIAL (2026-10-24) — primitives landed; the verbatim AC ("each role can only reach its own surface") is enforced by `requireRole` only once the first staff route calls it. That route lands in S04-01; the AC is carried by follow-up item S02-06 (guard wiring + denial test against a live route), per review round 2 finding 4369257038. Decision (2026-10-24): defer S02-06 to S04-01 rather than add a test-only service wrapper; do not tick the workbook until S02-06 closes.**

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

**Status: DONE (2026-10-25).** `src/knowledge/facts.ts` is the tenant-scoped fact service: create/update/list/get, verify with an actor, exact-key lookup of verified rows only, and contradiction listing. `db/migrations/0009_property_facts.sql` is the schema change; `src/fixtures/fixture-hotel.ts` carries `factKey` and the seed fills the new columns. No browser UI and no LLM call (S08 owns the screen, S04-01 the route).

- [x] **Schema (0009, operator-approved):** adds `unit` (CHECK: `text`, `time-of-day`, `hours`, `currency-amount`, `duration`, `distance`, `count`), `effective_from`, `source_article_version_id`, `verified_by`, `verified_at`; `property_facts_verified_fields` (verified ⇒ by + at + effective_from); composite FK to `article_versions`; **drops** 0001's `UNIQUE (property_id, topic_key, fact_key, language)` so unverified variants can coexist, and replaces it with the partial unique `property_facts_verified_key ... WHERE verified` (one verified holder per key + effective date) plus the `property_facts_lookup` index. Existing rows need no backfill UPDATE; `unit` defaults to `text`.
- [x] **Fixture/seed:** `FixtureFact.factKey` added (`closing_time` x2, `massage_60`, `facial`, `hours`); the seed writes `fact_key`/`unit`/`effective_from`/`source_article_version_id` with `ON CONFLICT (fact_id) DO UPDATE` on those four fields only — an existing demo DB is upgraded in place, counts stay 5, and an operator's `verified` is never reset. The two pool rows now share `(pool.hours, closing_time, es, 2026-01-01)` with 21:00 vs 20:00: a real contradiction. Spa prices differ by `fact_key`, so they are not one.
- [x] **Lookup (AC-1/AC-2):** `FACT_LOOKUP_SQL` is one `SELECT` over `property_facts` — no write clause, no embedding column, no ranking, no provider (asserted in `tests/knowledge/facts.test.ts`). It hard-filters `verified`, exact key/language/tenant, `effective_from <= on` (default today) and orders newest-first; unverified or unknown keys return `null`, never a guess. `on` must be a real calendar date or it is a `FactValidationError`.
- [x] **Verify (AC-3):** `verifyFact` resolves the actor first (`FactActorError` for missing/malformed/unknown users — a failed audit rolls the unit back), requires `effective_from`, locks the whole key group `ORDER BY fact_id FOR UPDATE`, refuses any other verified row with `FactContradictionError` (both ids + the conflicting value), then sets `verified/verified_by/verified_at` and writes `fact.verified`. Unique-violation (23505) is a backstop contradiction; FK (23503) becomes `FactActorError`. Re-verifying the same row is idempotent — the index bars a second *row*, not a second look.
- [x] **Update (AC-4):** any update rewrites the row and resets `verified=false`, `verified_by=NULL`, `verified_at=NULL`; the return reports `verifiedReset` so callers can explain the change. Lookup falls back to `null` afterwards unless another row is verified.
- [x] **Contradictions:** `listContradictions` groups by `(topic_key, fact_key, language, effective_from)` with `count(distinct fact_value) > 1`, returning values, verified flags and source version ids for S04-01's queue — both verified and unverified sides.
- [x] **Tenancy (AC-4):** foreign fact ids are `FactNotFoundError` for get/update/verify (no existence leak), foreign `sourceArticleVersionId` is `FactSourceVersionNotFoundError`, and `listFacts`/`lookupFact` are RLS- plus context-scoped.
- [x] **Audit (AC-6):** vocabulary gains `fact.created` and `fact.updated` (`fact.verified` existed); detail is `{topic_key, fact_key, unit, language, effective_from}` (+ `value` for verify) — never body/content. A failed `writeAudit` throws `AuditWriteError` and the transaction rolls the fact back with it.
- [x] **Validation:** keys are lowercase dot/underscore segments ≤120; value trimmed 1..500; unit from the closed CHECK; language 2-8 lowercase letters (the `es|en` article rule does not apply — the fixture uses `fr`); `effectiveFrom`/`on` are real dates (leap-day aware), future dates allowed.
- [x] **Tests:** `tests/knowledge/facts.test.ts` (11: key/value/unit/language/date validation, source-version UUID handling, whole-input normalization, lookup SQL shape with no write/embedding/provider keyword, contradiction SQL shape, unit set matching the migration's CHECK). `tests/db/facts.db.test.ts` (16: 0009 columns/constraints/dropped unique/partial index, seeded units+dates+version ids and the pool/spa key shape, null lookup before verification (incl. an unknown key), verify + contradiction refusal + lookup returns 21:00 + `verified_by/at`, effective-date window, the CHECK rejecting a verifier-stripped row, contradiction listing (pool yes, spa/gym no), update resets verification and lookup returns null again, create/get/list + audit detail, foreign source version refused, actor required three ways, idempotent re-verify, audit-failure rollback, cross-tenant invisibility, legacy row without `effective_from` refused). `tests/db/non-superuser.db.test.ts` migration count 8 → 9.
- [x] No new dependency, no route, no `requireRole` (S04-01 owns the guard), no LLM/embedding call anywhere in the module.

**Evidence (local, verified):**
```text
$ node --env-file=.env.local scripts/migrate.ts       # 1 applied (0009 lands)
$ node --env-file=.env.local scripts/seed.ts          # property_facts: 5 (new fields filled on an existing DB)
$ npm run db:test                                     # 123 passed (123), incl. 16 facts
$ npm test                                            # 149 passed (149), incl. 11 fact validation
$ npm run typecheck && npm run lint && npm run build  # all clean
```
