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

**Close-out, 2026-10-26 — the tick that was missed.** The code merged in PR #32 and every line above was written then, but `S03-03` was never ticked in the workbook and epic #27 stayed open, so each progress report since — including the one that closed S07 — under-counted S03 by one item and 2.0 days and read the sprint as 2/3. There was no missing code; there was a missing spreadsheet cell.

Re-verified on `main` at `9b3f107` rather than taken on trust from the entry above, because S04–S07 have landed on top of this surface since:
```text
$ npm run db:migrate   # 20 applied (0009 among them)
$ npm run db:seed      # {"property_facts":5,...}
$ npm run db:test      # 28 files / 243 passed — incl. the 20 fact cases
$ npm test             # 38 files / 500 passed — incl. the 17 fact validation cases
$ npm run typecheck && npm run lint   # clean
```
Ticked with that evidence and epic #27 closed; S03 is now 3/3.

**The lesson, kept here because this is the checklist that failed:** the runbook entry is not the close-out. The workbook tick is, and it is the only thing `scripts/progress.mjs` reads. An item whose evidence is written and whose cell is empty is an item the project still believes is unstarted.

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

## S07-05 - Outage fallback (0.50d)

**AC (verbatim):** Kill the AI mid-conversation; guest still gets an honest message.

- **AC-1** Provider failure mid-turn results in `guest.team_will_reply` + a `service_requests` row, never a 5xx or an empty reply.
- **AC-2** `message_failed` event is emitted for observability.

**Status: DONE (2026-10-25).** `src/ai/answer.ts` (`recordOutage`), `src/ai/contract.ts` (`AI_RUN_REASON_CODES`), `src/ai/provider.ts` (`AiUnavailableError.modelIds`), `src/ai/chaos.ts`, `src/guest/runtime.ts`, `src/guest/service.ts`, `.env.example`; tests `tests/ai/outage.test.ts`, `tests/db/outage.db.test.ts`. **No migration** — see below.

**What was already true, and what was not.** S05-01's wrapper has thrown `AiUnavailableError` on a double provider failure since it was written, and the guest has been getting catalogue copy for it ever since. What the outage path did **not** do was leave any trace: no `ai_runs` row, no `message_failed` event — the `message_failed` name had been in the taxonomy since S01 and had never once been emitted. So "the AI was down" was invisible in the database, indistinguishable from a quiet evening, and an outage could not be told apart from a refusal when reading the accuracy numbers that sample `ai_runs`.

**The decisions that shaped the code:**

- *The evidence is written where the failure happens, in the caller's transaction.* `recordOutage` writes the `ai_runs` row and the `message_failed` event inside the turn's transaction, so a turn that rolls back leaves no outage behind — a dashboard must count failures a guest actually experienced, not attempts the system abandoned.
- *One helper, two catches.* The provider call inside `answerMessage` is not the only place an outage can surface: an adapter that throws outside the resilience wrapper is caught in `src/guest/service.ts`. Both now call the same `recordOutage`, because "was it recorded?" must not depend on which catch saw it.
- *`model_id = 'none'` on an outage row.* `ai_runs.model_id` is `NOT NULL` and per-model accuracy is sampled from this table. Naming `gemini-2.5-flash` for a call it never answered would put an outage in that model's denominator and quietly make it look worse. The attempted ids travel in `usage.models` instead, so the information is kept without the lie.
- *Two reason-code vocabularies, not one.* The charter said to add `provider_unavailable` to "the closed reason_code enum used by `guard.ts`" — but that constant (`AI_REASON_CODES`) is also the enum shipped to the model in its JSON schema. Adding it there would let a model *claim* an outage, which is a sentence nobody should be able to write. So `AI_RUN_REASON_CODES` is the model's list **plus** `provider_unavailable`, and `recordAiRun` validates against that superset; the schema enum is untouched. No migration was needed because `ai_runs.reason_code` is unconstrained `text` and the vocabulary has always been enforced in TypeScript.
- *`guest.team_will_reply` was not added* (the same call as S07-04, and for the same reason): `guest.unavailable` already says "I can't answer right now, but I've passed this to the team — a person will reply here shortly", and that is already the string this path sends. A third key carrying one promise is how two promises drift apart. The `service_requests` row behind it was already captured by S07-03 (`topic = 'ai_unavailable'`).
- *The recovery is a human, not a silent resume.* After an outage turn the conversation sits in `awaiting_staff` (S06-02), so the guest's next message gets `guest.staff_reply_pending` instead of a model answer. The mid-conversation test asserts exactly that: the outage has a consequence, and the consequence is a person.
- *`AI_FAIL_MODE` refuses to be on in production.* `none | once | always`, resolved at boot; anything but `none` under `APP_ENV=prod` is a **boot failure**. A host that can be made to fail its AI by an environment variable is a host where one copied `.env.staging` is an outage. The failure it injects is the real `AiUnavailableError` from the real class — a chaos hook with its own error type would only prove that the error type is handled.
- *`once` is stateful, on purpose.* It consumes exactly one generation, so "answer, outage, answer" is testable in one process; `always` is the provider-is-down case. Neither touches the wrapped circuit state: a deliberate failure is not a provider outage, and letting it trip the real breaker would poison the next 60 seconds of genuine traffic.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm test        # 35 files / 457 passed (15 new outage/chaos cases)
$ npm run db:test # 27 files / 237 passed (5 outage cases)
$ npm run eval    # unchanged four scores; regression gate pass
$ npm run typecheck && npm run lint && npm run web:build   # clean
$ npm run db:migrate   # still 19 applied — this item changed no schema
```

**Not done, by charter:** transport retry/circuit policy (S07-06 — it decides how often this path is reached, and `ai_runs.reason_code = 'provider_unavailable'` is the number to tune it against). **Also owed:** nothing alerts on `message_failed` yet (the reliability item owns dashboards), and the chaos run should join the staging smoke script rather than living only in tests.

## S07-06 - LLM transport resilience (0.50d)

**AC (verbatim):** Both providers killed; product degrades honestly.

- **AC-1** 8s generation / 3s classification timeouts, two retries with jitter on 429/5xx only, 60s circuit break to the secondary.
- **AC-2** Pinned model versions; provider-native structured outputs + server-side validation.
- **AC-3** Parse-failure rate is an alerting metric.

**Status: DONE (2026-10-25).** `src/metrics/counters.ts` (new), `src/ai/provider.ts`, `src/ai/answer.ts`, `src/config/env.ts` (`LlmConfig.retries`), `src/guest/runtime.ts`, `src/server.ts`; tests `tests/metrics/counters.test.ts` (new), `tests/db/metrics.db.test.ts` (new), `src/config/env.test.ts`. **No migration** — see below.

**What was already true, and what was not.** The transport policy itself was S05-01's and has been enforced since: timeouts, jittered retries on 429/5xx only, a 60s circuit break to the secondary, `AiUnavailableError` when both are down, and pinned model ids that `src/config/env.ts` refuses to default. What was missing was **step three of the charter: the parse-failure rate was not a number anywhere.** A model could return JSON that failed the contract all night, the guest would correctly get the honest fallback, and the only trace was a log line nobody counts.

**The decisions that shaped the code:**

- *Four counters, a closed vocabulary, an allowlist of labels.* `ai_parse_failure_total`, `ai_fallback_total`, `ai_circuit_open_total`, `ai_outage_total`. Labels are `org_id`, `property_id`, `model` and nothing else — the counter API rejects anything else rather than accepting a free-form object, because the first time someone passes `{question}` "for debugging" the counter table becomes a transcript.
- *Counters only, no histograms.* A rate needs a numerator and a denominator, both of which are counts (`ai_parse_failure_total` over turns). Latency percentiles are a different item with a different sink; shipping half a histogram here would have implied coverage that does not exist.
- *The sink is injected, and a broken sink cannot break a turn.* `setCounterLogger` is called once at boot in `src/server.ts`; with no sink the counters are still counted and simply not emitted (every test runs that way). The call is wrapped in try/catch and pinned by a test: metrics are an observability feature and a guest turn must never fail because a logger threw.
- *The retry budget became configuration: `LLM_RETRIES` (default 2, range 0–4).* The charter fixed "two retries"; the range exists because the ceiling is a product judgement, not a transport one — with an 8s timeout, four retries is 32 seconds of a guest watching a spinner. Anything outside 0–4 is a `ConfigError` at boot, not a silent clamp.
- *`ai_runs` already had the denominator, so nothing new was stored.* The reason codes from S07-05 (`provider_unavailable` in `AI_RUN_REASON_CODES`) are the per-turn record; the counters are the rate. Recomputing one from the other in SQL is possible but slow at the wrong moment, which is why both exist.
- *Nothing pages anybody yet.* AC-3 says the parse-failure rate is an alerting metric; S11-04 turns counters into alerts. Saying "alerting" in a runbook while nothing alerts would be the exact dishonesty this sprint exists to remove, so the close-out says what is true: the number is emitted, on a `metrics.counter` log line, in a shape a log-based alert can consume.

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm test        # 38 files / 500 passed (12 counter cases, +3 through the DB pipeline)
$ npm run db:test # 28 files / 243 passed
$ npm run typecheck && npm run lint && npm run web:build   # clean
$ npm run db:migrate   # still 19 applied at the time of this item; 0020 belongs to S07-01
```

**Not done, by charter:** dashboards and alert rules (S11-04); exact token accounting from provider `usageMetadata` and the first invoice reconciliation (still owed from S07-04). **Also owed:** `LLM_RETRIES` should be exercised against a real provider in staging — the retry path is proven by unit tests against scripted providers, not by burning real quota.

## S07-01 - QR + embeddable snippet (0.50d)

**AC (verbatim):** QR resolves to the right property on a real phone.

- **AC-1** `GET /c/:slug/qr.svg` returns a scannable SVG encoding the public chat URL.
- **AC-2** A copy-paste `<script>`/iframe snippet embeds the same chat on the hotel site.

**Status: DONE (2026-10-25), with one manual evidence item still owed.** `db/migrations/0020_embed_settings.sql`, `src/settings/schema.ts` (`embed`), `src/guest/links.ts` (new), `src/guest/qr.ts` (new), `src/guest/session.ts`, `src/guest/service.ts`, `web/middleware.ts` (new), `web/lib/property.ts` (new), `web/lib/api-base.ts` (new), `web/app/c/[slug]/{qr.svg,embed.js,embed.txt}/route.ts` (new); tests `tests/guest/links.test.ts` (new), `tests/guest/qr.test.ts` (new), plus cases in `tests/settings/schema.test.ts`, `tests/db/settings.db.test.ts`, `tests/db/guest-chat.db.test.ts`, `tests/db/schema.db.test.ts`, `tests/db/non-superuser.db.test.ts`.

**What the code does, in one pass.** The property is resolved by the same slug lookup the chat page uses (a QR for a slug that does not resolve is a published 404), then `GET /c/:slug/qr.svg` encodes `<GUEST_PUBLIC_URL or request origin>/c/<slug>` as vector SVG; `GET /c/:slug/embed.txt` returns the copy-paste snippet; `GET /c/:slug/embed.js` returns the script it loads, which mounts an iframe of the same URL; and `web/middleware.ts` puts `frame-ancestors` on the chat page itself, per property, from `settings.embed.allowed_origins`.

**The decisions that shaped the code:**

- *`qrcode` (+ `@types/qrcode`), operator-approved 2026-10-25.* The charter offered vendoring a tiny encoder or an approved dependency; a hand-rolled QR is the one kind of bug that passes every test and fails in a lobby, because a subtly wrong code does not throw — it scans to nothing. It is the only runtime dependency this item added, and it is pure JavaScript (no native build, no service call, so the URL never leaves our process).
- *The payload is the plain guest URL.* No tenant id, no shortener, no signed token, no tracking parameter. A laminated card is photographed, reposted and re-printed; a code that leaks only what a guest could have typed by hand leaks nothing.
- *Error-correction level M with a two-module quiet zone.* L is smaller and survives a clean screen; M (15%) is the cheap insurance for a scuffed card. The spec asks for four modules of margin — two is the smallest value that scans reliably on paper, and a printed card usually carries its own margin.
- *A slug that is not a slug never becomes a QR.* `SLUG_RE` is ASCII-only (`[a-z0-9-]`), which refuses `../`, over-long values, and the lookalikes that matter on a printed card: a Cyrillic `а` or a non-breaking hyphen renders identically and is a different string, so it would 404 for every guest who scanned. `links.ts` declares its own copy of the pattern so the module stays pure enough to bundle into Next middleware, and a test pins it to `session.ts`'s.
- *`embed.allowed_origins` is a required setting, and empty means nobody.* Migration `0020` backfills `[]`, moves the other keys' validation into `property_settings_valid_v3`, and rebinds the CHECK. Matching is **exact origin**, never a prefix: `https://hotel.example` must not admit `https://hotel.example.evil.test`, which `startsWith` would. Wildcards, paths and trailing slashes are rejected by both the parser and the CHECK (tests assert the two agree), and the ceiling is ten origins so the CSP header stays small.
- *The allowlist is read without widening the guest role.* `concierge_public`'s column grant on `properties` excludes `settings` on purpose (staff contact details live there). Instead of granting a stranger-only role access to settings, `src/guest/session.ts` copies `embed.allowed_origins` out **after** switching up to `concierge_app`, as a separate `frameAncestors` field. A settings value that fails to parse yields `[]` (nobody may embed), never a 500: embedding is a distribution channel, the chat is the product. `tests/db/guest-chat.db.test.ts` pins both the value and the fact that the public view still exposes exactly six fields.
- *Framing is enforced by the page, in middleware.* The App Router has no per-page header API, so `web/middleware.ts` matches `/c/:slug` exactly (the QR and the script are files, not documents, and staff routes are untouched), reads the allowlist from the API, and caches the directive in memory for 60s per slug. A per-request lookup would put our own API in the critical path of the most-visited route; a minute of staleness on a *framing* header is the right trade. `'self'` is always included — "nobody may embed" must not become "nobody may visit" — and an API failure caches `'self'`, never a wildcard.
- *`GUEST_PUBLIC_URL` overrides the request origin.* A server behind a proxy does not know its public name, and a QR encoding `http://127.0.0.1:8787` scans to nothing. Both routes prefer the configured origin and fall back to the request's own, which is the honest answer for local dev and preview hosts; `.env.example` says it must be set in production, because a printed card outlives the deploy that produced it.
- *The snippet is the same function the tests exercise.* `GET /c/:slug/embed.txt` is the copy-paste text and `embedSnippet()` is what the tests cover, so what is handed to a hotel is what was verified — no second implementation living only in a docs page.
- *The embed script does not set `sandbox`.* The chat needs cookies and forms; a sandbox without `allow-same-origin allow-forms allow-scripts` would break the thing it embeds. `frame-ancestors` on our side is the control: the page decides who may frame it, not the framer.

**A CI failure that changed where the encoder lives.** The first version put
`QRCode.toString` behind a `web/app/c/[slug]/qr.svg/route.ts` that imported
`src/guest/qr.ts`. It built locally and **failed in CI**: the `web-build` job runs
`npm ci` inside `web/`, so the root `node_modules` that satisfies `qrcode` is not
there, and a cross-project source import resolves the package from the issuer's
directory (`src/guest/`) upwards — never into `web/node_modules`. Adding the
dependency to `web/package.json` would not have fixed it for the same reason.
The QR is therefore encoded by the tier that owns the slug lookup and the
encoder, `GET /api/chat/qr.svg?property=<slug>&base=<origin>`, and the web route
proxies it exactly like `/api/chat/property`. One encoder, one 404, and no
runtime dependency crossing the project boundary. Pure TypeScript (`links.ts`,
`catalog.ts`) still crosses it, which is fine and was already the case.

**A boot failure that neither `tsc` nor vitest catches.** `GuestRawResponse` was
first written with TypeScript *parameter properties*
(`constructor(readonly body: string, …)`). That type-checks, passes vitest, and
**crashes at boot** under Node's `--experimental-strip-types`
(`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — the server is not transpiled, it is
type-stripped, so only erasable syntax is allowed. Fields are now declared and
assigned explicitly. Standing rule: any new class in `src/` is exercised once by
starting the real server (`node --experimental-strip-types src/server.ts`), not
only by the test runner.

**A bug found by curling the running stack, not by a unit test.** The first snippet emitted `src="…/c/demo?lang=es/embed.js"` — the query string before the file name, a 404 on every hotel site. Every unit test passed because each one asserted the pieces separately. Fixed by `embedScriptUrl()` plus a named assertion (`?lang=en/embed.js` must not appear); the general lesson is in §"Standing procedure" below.

**Live verification (API on :8787, `web/` on :3000, seeded `demo` property):**
```text
GET /c/demo/qr.svg     200 image/svg+xml  1255 bytes; bytes identical to a fresh encode of
                       http://127.0.0.1:3000/c/demo  → the served code encodes the right URL
GET /c/demo/embed.txt  200 text/plain  — <div id="concierge-chat">…</div> + <script src="…/c/demo/embed.js?lang=es" async>
GET /c/demo/embed.js   200 application/javascript — mounts an iframe of …/c/demo?lang=es
GET /c/demo            content-security-policy: frame-ancestors 'self' https://hotel.example http://localhost:4000
                       (header appears only after settings.embed.allowed_origins is set; with [] it is 'self')
```

**Evidence (local, PostgreSQL 16.2 + pgvector + pg_trgm):**
```text
$ npm run db:migrate # 20 applied (0020 new)
$ npm test        # 38 files / 500 passed (23 link cases, 5 QR cases)
$ npm run db:test # 28 files / 243 passed (embed allowlist + public-view shape)
$ npm run typecheck && npm run lint && npm run web:build   # clean; three new routes in the manifest
```

**Still owed — the one thing this item cannot close itself: a scan on a real phone.** AC-1 says *"QR resolves to the right property on a real phone"*, and this environment has no camera. What is proven is that the route returns an SVG which encodes exactly the expected URL (byte-compared against a fresh encode) and that the encoder is the approved library at error-correction M. What is **not** proven is the scan itself. Procedure for the operator:

1. Deploy `web/` with `GUEST_PUBLIC_URL` set to the public origin.
2. `curl -s https://<host>/c/<slug>/qr.svg -o /tmp/qr.svg` and open it.
3. Hold a phone camera to it; the preview must read `https://<host>/c/<slug>` and land on that property's chat.
4. Record the host, the date and the slug in this section. Until then, treat AC-1 as *unverified on hardware*.

**Not done, by charter:** print design (the card itself), WhatsApp entry point (WA track). **Also owed:** a staff-facing screen that shows the snippet and the QR to a hotel owner — today the operator hands them over via `embed.txt` and the SVG file, which is enough for the pilot but is not self-service; and `frameAncestors` is decorated per replica, so an allowlist change reaches every instance within 60 seconds rather than instantly.

**Standing procedure — run the stack before believing the tests.** S07-01 shipped a snippet whose script URL was a 404 in every unit test's blind spot. Two commands, in the lifecycle of any item that emits a URL, a script, or a header:
```text
$ DATABASE_URL=… GUEST_COOKIE_SECRET=… PORT=8787 node --experimental-strip-types src/server.ts &
$ (cd web && REVIEW_API_URL=http://127.0.0.1:8787 npm run dev) &
$ curl -sD- -o /tmp/out https://<preview-or-local>/c/<slug>{,/qr.svg,/embed.txt,/embed.js}
```
Read the status, the content type and the body. A generated artifact is not verified until it has been fetched from a running process.

## S08-01 - Phone-first shared inbox (2.00d)

**AC (verbatim):** An agent triages a queue on a phone in under 60 seconds.

- **AC-1** `GET /staff/inbox` shows needs-attention / mine / unresolved filters with last message + wait time.
- **AC-2** Every query is tenant-scoped and paged; p95 read <300ms at fixture scale.

**Status: DONE (2026-10-26), with one human-measured evidence item still owed.** `src/inbox/queries.ts` (new), `src/staff/http.ts` (the pipeline became shared), `db/migrations/0021_inbox_indexes.sql` (new), `src/server.ts` (wiring), `src/i18n/catalog.ts` (inbox + `staff.common.*` copy), `web/app/(staff)/inbox/page.tsx` (new), `web/app/(staff)/layout.tsx` (nav), `web/lib/types.ts`; tests `tests/inbox/queries.test.ts` (new), `tests/db/inbox.db.test.ts` (new).

**The path moved, and that is the first thing to know.** The charter said `GET /staff/inbox`; this repository's staff surface has been `/api/*` behind `handleStaffRequest` plus a Next page since S04-01. So the API is **`GET /api/inbox?filter=&limit=&cursor=`** and the screen is **`/inbox`**. `handleReviewRequest` and the new `handleInboxRequest` are now both thin wrappers over one `handleStaffRequest` — token → tenant headers → `withStaffSession` → `requireRole`. A second copy of that sequence is exactly how a surface ends up missing its authorisation check, and the inbox is a list of strangers' conversations.

**The decisions that shaped the code:**

- *Keyset paging, never OFFSET.* A guest message between page 1 and page 2 re-sorts an OFFSET query, so the agent silently sees a row twice or never sees it — and never finds out. The cursor is `(last_activity_at, conversation_id)` as opaque base64url JSON, validated on the way back in: a hand-edited cursor is a 400, not a page from somewhere else. The tenant predicate runs first, so even a forged cursor cannot reach another property's range.
- *One statement, not four.* The last message and the open request are `LEFT JOIN LATERAL ... LIMIT 1` against the row the ordered scan already chose. Fetching messages per conversation afterwards is the N+1 that hides at fixture scale and falls over at 200 conversations — and on a phone it is the difference between a queue that appears and one that loads.
- *`unresolved` is about requests, not conversations.* A conversation can be answered and finished while a request it opened is still open, and that is precisely the row a hotel loses track of. `needs_attention` is `ai_state = 'awaiting_staff'` — the only queue where doing nothing costs money — and it is the default.
- *"Mine" is request assignment, because that is what the schema has.* `assignments` has hung off `service_requests` since 0001, never off conversations. The filter reads what S08-03 will write.
- *The screen is a server component with `<Link>` tabs.* The inbox is one GET and a list; a client-side version would trade that for a loading state, an error state and a retry — three things that can be wrong while an agent stands in a lobby. Links also mean the filters are the back button, which `useState` is not. DEC-1 says React, not `"use client"`.
- *Wait time comes from the database clock, formatted in the component.* A phone with a skewed clock must never show "-3 min waiting", and "who waited longest" is the ordering the screen promises. The catalogue holds templates with a `{count}` hole (the `guest.chat.rate_limited_seconds` convention); the number is filled where the number is.
- *Three indexes, and two charter indexes that did not ship.* `0021` adds the last-message index (with `message_id` in it, because `created_at` is not unique — a turn writes the inbound and the outbound row in one transaction), `assignments_user` for "mine", and the keyset page index with `org_id` leading and `conversation_id` trailing. The charter's `service_requests_open_by_conversation` **already exists** in 0017, and shipping it twice would be a second index to maintain on the guest write path for one read.
- *The observer deviation, recorded rather than silently fixed.* The charter's test plan expected `observer → 403`; the shipped matrix grants `queue: read` to all four roles and this item adds no write action, so an observer reads the queue (and `mine` is empty). The 401/400/404 deny paths are tested. Making observers read-only-denied is a matrix change with its own test.

**Evidence (local, PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm):**
```text
$ npm run db:migrate   # 21 applied (0021 lands)
$ npm run db:test      # 29 files / 253 passed (10 inbox cases: filters, tenancy, keyset paging, plan, 401/400/404)
$ npm test             # 39 files / 514 passed (14 pure inbox cases)
$ npm run eval         # regression gate pass; absolute gate unchanged (golden v1 is 20 questions, needs 50)
$ npx tsc --noEmit && npm run lint   # clean
$ npm run web:build    # green; /inbox in the manifest
```

**Live wiring check:** with the real server up and no Neon auth configured, both `/api/inbox` and `/api/inbox/anything` answer `503 {"detail":"NEON_AUTH_JWKS_URL is required"}` — the same degraded-host contract as `/api/review/*`, which is what proves the inbox branch reaches the shared pipeline instead of falling through to the health table.

**Owed — the thing this item cannot measure itself: 60 seconds on a phone.** AC-1's clause is a human stopwatch. What is proven is the machine half (one round trip, 20 rows, single-digit milliseconds server-side, an index-backed plan). Procedure for the operator:

1. Deploy with auth configured; sign in as `front_desk` on a real phone.
2. Have the demo property open three conversations that land in `awaiting_staff` (the guest "talk to a person" button in `/c/<slug>` does this).
3. Time from opening `/inbox` to tapping into the oldest conversation. Record phone model, property and date here.
4. Screenshot the queue at 390px width into this section.

**Not done, by charter:** reply/takeover/assign/resolve (S08-03), the AI-sources pane (S08-02), AI operating modes (S08-04). **Also owed:** there is no realtime — the page is a snapshot and an agent refreshes; that becomes real in S08-03 when rows grow actions.

## S08-02 - Conversation detail with AI sources (1.00d)

**AC (verbatim):** Staff can see the cited text verbatim.

- **AC-1** The detail view shows each AI message's citations with the exact `article_version` body/quote that was used.
- **AC-2** Editing the article later does not change what the staff member sees for an old answer.

**Status: DONE (2026-10-26), with one operator artifact owed (the §7 screenshot).**
`src/inbox/detail.ts` (new), `src/ai/history.ts` (`loadCitations` extracted, quote added), `src/ai/runs.ts` (`recordCitations` persists the quote), `src/ai/answer.ts` (passes it through), `src/staff/http.ts` (the route), `src/i18n/catalog.ts` (detail copy, en+es), `db/migrations/0022_citation_quotes.sql` (new), `web/app/(staff)/inbox/[conversationId]/page.tsx` (new), `web/app/(staff)/inbox/page.tsx` (rows link through), `web/lib/types.ts`; tests `tests/db/inbox-detail.db.test.ts` (new), `tests/inbox/detail-page.test.ts` (new).

**The decision this item actually turned on.** S05-03 shipped `citations` with `article_version_id` and nothing else, and its own comment said the verbatim `quote` "belongs in a new column, not in a JSON blob — and that is a migration, not a silent change here". **0022** is that migration:

```sql
ALTER TABLE citations ADD COLUMN quote text;
ALTER TABLE citations ADD CONSTRAINT citations_quote_shape
  CHECK (quote IS NULL OR length(btrim(quote)) BETWEEN 1 AND 400);
```

The alternative was to render the whole version body and call it "the cited text". That is not what the AC says, and in practice it means an agent scrolling a 19,000-character noticeboard for one sentence while a guest waits. The quote is also the only string in this system that `src/ai/guard.ts` has *proven* appears in the cited version — storing it is storing a verified fact, not a claim.

`quote` is nullable on purpose: pre-0022 citations keep `NULL` and the pane falls back to the body. Inventing quotes for old rows would be falsifying history. The `1..400` bound mirrors `src/ai/contract.ts`, so a row that could not have come out of the model is refused by the table as well.

**AC-2 is a schema property, and the code refuses to undermine it.** Versions are immutable (0003) and citations point at versions (D5), so the pane reads `article_versions.body` and never `knowledge_articles`. The test publishes v2 and then v3 after the answer and re-reads: quote and body byte-identical, `version_no` still 1, `isCurrent` flipping to `false`. A citation that is no longer current is labelled in the UI — that is history working, not an error to chase.

**One join, two callers.** The citation SELECT moved into `src/ai/history.ts::loadCitations(client, context, aiRunIds)` filtered by `ai_run_id = ANY(...)`; `reconstructAnswer` passes one id, `getConversationDetail` passes the conversation's runs. A test asserts both return the same quote, because the failure mode of a copied join is one of them quietly drifting.

**Route and tenancy.** The charter guessed `?conversation=`; the shipped route is **`GET /api/inbox/conversations/:id`** (a resource on the collection that already exists). It runs through the shared `handleStaffRequest` (`queue: read`), and a malformed, unknown or foreign id all return **404 with an identical body** — the route never confirms that a conversation exists to someone who cannot read it. `timeZone` comes back with the payload so the screen formats hotel-local times instead of the server's (UTC in CI, usually wrong).

**Escaping.** Guest bodies travel raw: escaping in the service corrupts the transcript for other consumers and double-escapes on the next hop. The page renders every body as a JSX text child, and `tests/inbox/detail-page.test.ts` scans the source (comments stripped) and fails if `dangerouslySetInnerHTML` or `innerHTML` appears — the one edit that would turn a guest message into script. The DB test asserts the hostile body `"<script>alert(\"xss\")</script> …"` round-trips unchanged, so nothing upstream is pre-escaping it either.

**`data-ai-run-id`** is emitted on every AI message block for S09-03's one-click flag.

**Evidence (local, PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm):**
```text
$ npm run db:migrate   # 22 applied (0022 lands)
$ npm run db:test      # 30 files / 261 passed (8 inbox-detail cases)
$ npm test             # 40 files / 518 passed (4 detail-page source cases)
$ npx tsc --noEmit && npm run lint   # clean (root and web/)
$ npm run web:build    # green; /inbox/[conversationId] in the manifest
```

**Not done, by charter:** flagging persistence (S09-03), reply/takeover (S08-03), and no live refresh — the transcript is a snapshot like the list.

**Owed — §7's screenshot of the sources pane.** It needs a signed-in staff session against a seeded tenant, so it is an operator artifact like S08-01's stopwatch. Procedure:

1. `npm run db:seed`, then start the API and `npm run web:dev`; sign in at `/session` as a `front_desk` user.
2. In `/c/<slug>`, ask the demo guest something the knowledge base answers (pool hours, wifi), so an `ai_runs` row exists with citations.
3. Open `/inbox` → the conversation → screenshot the AI message with its Sources pane (quote visible, body expanded once) at 390px width.
4. Paste the screenshot here with property, date and the AI run id.

## S08-03 - Reply, take over, assign, resolve (1.50d)

**AC (verbatim):** No race where AI replies after a takeover.

- **AC-1** Takeover, reply, assign and resolve are atomic under a `FOR UPDATE` conversation lock.
- **AC-2** An AI writer that started before a takeover loses the race deterministically.

**Status: DONE (2026-10-26).** `src/inbox/actions.ts` (new), `src/conversation/state.ts` (`readState`, `lockStateWith`, lock-strength split), `src/guest/service.ts` (no lock across the model call; `assertModelMaySpeak` after it), `src/staff/http.ts` (four routes + status mapping), `src/i18n/catalog.ts` (action copy, en+es), `db/migrations/0023_staff_action_guards.sql` (new), `web/app/(staff)/inbox/[conversationId]/page.tsx` (action bar), `web/app/(staff)/inbox/[conversationId]/actions.ts` (new, server actions); tests `tests/db/takeover-race.db.test.ts` (new), `tests/db/inbox-actions.db.test.ts` (new), `tests/inbox/actions.test.ts` (new).

**The finding that changed the design.** The charter said both writers take `FOR UPDATE` on the conversation row. That satisfies "mutually exclusive" and fails the actual AC, because S06-02 held that lock for the *entire guest turn*, model call included: an agent clicking "take over" waited for the provider, and the turn that started first still spoke last.

Removing the early lock is necessary but not sufficient. Inserting the guest's inbound message takes a **`FOR KEY SHARE`** lock on the conversation row (its foreign-key check), and `FOR KEY SHARE` conflicts with `FOR UPDATE`. So the takeover still blocked — for the whole model call — until the lock strengths were split:

| writer | lock | effect |
|---|---|---|
| staff actions | `FOR NO KEY UPDATE` | does not conflict with the guest turn's `FOR KEY SHARE`, so a takeover commits mid-model-call; conflicts with itself, so two agents serialise |
| `assertModelMaySpeak` (the AI's pre-write check) | `FOR UPDATE` | waits for a committing takeover, then reads `awaiting_staff` and aborts |

PostgreSQL's row-lock matrix is the authority here; anyone changing either mode must keep the pair asymmetric, or AC-2 flips back to "the bot wins".

**What a lost race looks like to a guest.** The model's answer is discarded, the catalogue's `guest.staff_reply_pending` line is sent instead, and a `needs_human` request is opened in the same transaction — a promise with no queue row behind it is the failure S07-03 exists to prevent. The `ai_runs` row is kept: the call happened and it cost money.

**The actions.** Every one locks the conversation, re-reads `ai_state` from the locked row, then writes. Reply takes over *first* in the same transaction (otherwise there is a window where the model answers and a human answers the same question). Assignment is one `INSERT ... ON CONFLICT DO NOTHING` against the new unique index — `created: false` on a replay, and no second `request_assigned` event. Resolve closes the conversation and **every** open request on it. Takeover is idempotent (`alreadyOwned: true`) and audits with the acting user.

**Route shape:** `POST /api/inbox/conversations/:id/{takeover,reply,assign,resolve}`, `queue: write` (observer is 403 on all four, and the pure tests assert the denial costs zero queries). 400 invalid · 403 role · 404 foreign/unknown · 409 `assignee_not_member` / `request_not_open` / `illegal_transition`.

**Migration 0023 — and the charter's index that could not work.** The proposed `UNIQUE (org_id, property_id, request_id, assigned_to, created_at)` cannot stop a replay, because `created_at` defaults to `now()`: a retried request inserts a second row that looks legitimately new. The shipped index drops `created_at`. 0023 also adds `service_requests_acknowledged_shape` (`acknowledged_at IS NULL OR status <> 'new'`, no backfill) and widens `handoff_reasons.reason_code` with `staff_takeover`, so a proactive human takeover stops being recorded as `guest_asked_human`.

**UI:** three plain forms posting to server actions — works before hydration, keeps the bearer token in the HttpOnly cookie. "Assign to me" is the only assignment offered; a colleague picker is a settings surface and the API already takes any `assigneeUserId`.

**Evidence (local, PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm):**
```text
$ npm run db:migrate   # 23 applied (0023 lands)
$ npm run db:test      # 32 files / 272 passed (race: 2, actions: 9)
$ npm test             # 41 files / 523 passed (actions: 5, detail page: 5)
$ npx tsc --noEmit && npm run lint   # clean (root and web/)
$ npm run web:build    # green; /inbox/[conversationId] in the manifest
```

**The race case, in one line:** a scripted provider parks inside `generate`, the takeover runs on a *second connection*, the takeover must commit within 3s (if it blocked, the test errors rather than hanging), and exactly one outbound message exists afterwards — the pending line, never the model's answer.

**Not done, by charter:** operating modes (S08-04), notification email (S09-05), internal notes, reassignment to another user from the UI.

## S08-04 - AI operating modes (1.00d)

**AC (verbatim):** Mode change applies to the next message, no deploy.

- **AC-1** `auto | draft | human_only | after_hours` selected per property.
- **AC-2** Flipping the mode changes the very next message's decision without restart; `draft` escalates, `after_hours` uses the property's `time_zone`.

**Status: DONE (2026-10-26).** `src/settings/mode.ts` (new), `src/staff/http.ts` (settings routes + a dispatcher fix), `src/server.ts` (wiring), `src/i18n/catalog.ts` (`staff.mode.*`, en+es), `web/app/(staff)/settings/page.tsx` + `actions.ts` (new), `web/app/(staff)/layout.tsx` (nav), `web/lib/types.ts`; tests `tests/db/ai-modes.db.test.ts` (new), `tests/settings/mode.test.ts` (new), `tests/settings/policy.test.ts` (DST case), `tests/runtime/strip-types.test.ts` (new guard).

**Most of the item already existed, and saying so is the honest close-out.** `policyGate` / `escalationDecision` have been mode-aware since S05-02, and `answerMessage` SELECTs `ai_mode, time_zone, languages, settings` at the top of every turn — so the "no restart" property was true before this item started. What S08-04 adds is a *surface* (GET/POST `/api/settings/ai-mode`, `settings: read|write`), an audit trail with the previous value, and a test that would notice if somebody ever cached the mode.

**Where the mode lives.** `properties.ai_mode` — a column with a CHECK, not a `property_settings` table (the charter's wording is corrected in §10; `properties.settings` is the JSONB for tunable policy). `savePropertySettings` patches that JSONB and is deliberately not reused: folding a column into a JSONB patch helper would mean two storage shapes pretending to be one.

**AC-2's proof.** `tests/db/ai-modes.db.test.ts` flips the mode through the HTTP route and sends the next message in the same process, on the same pool, with no reload:

| flip | next message | provider calls |
|---|---|---|
| `auto` | answered | 1 |
| `human_only` | escalate, `mode_human_only` | **0** |
| `draft` | escalate, `mode_draft` | **0** |
| `after_hours` at 15:00Z (09:00 local) | answered | 1 |
| `after_hours` at 04:00Z (22:00 local, prev day) | escalate, `after_hours` | **0** |

The counting provider matters: a decision string alone cannot distinguish "the model was never called" from "the model was called and refused". The pure suite also gained a DST case — 13:30Z is 08:30 on 2026-03-07 and 09:30 on 2026-03-08 in New York, so the same UTC hour crosses the open/close line.

**A dispatcher bug this item surfaced.** `/api/settings/ai-mode` is the first resource with both a GET and a POST. `handleStaffRequest` matched the route on path only and then answered 405 when the method differed, which would have made one of the two permanently unreachable. It now matches on path **and** method and sets `Allow` from every method registered for that path.

**A regression found while live-checking, and the guard for it.** S08-03's `RequestNotActionableError` used a TypeScript parameter property (`constructor(readonly reason: ...)`). Node's `--experimental-strip-types` refuses that syntax, so **the API could not boot at all** — with `typecheck`, `test`, `db-test` and the entire CI matrix green, because `tsc` and vitest both compile it happily. `tsc`/vitest cannot catch this class of bug; only running the server can.

`tests/runtime/strip-types.test.ts` now imports every module under `src/` (except `server.ts`, which binds a port) in one child process with the server's own flags, and fails on `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. It was verified against a probe: planting a parameter property in `src/` makes it fail, removing it makes it pass. **Add this to the pre-merge checklist** — a green matrix does not mean the process starts.

**Evidence (local, PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm):**
```text
$ npm run db:migrate   # 23 applied (no new migration this item)
$ npm run db:test      # 33 files / 279 passed (7 mode cases)
$ npm test             # 43 files / 531 passed (5 pure mode, 1 DST, 1 runtime guard)
$ npx tsc --noEmit && npm run lint   # clean (root and web/)
$ npm run web:build    # green; /settings in the manifest
```
Live: `GET /api/settings/ai-mode` answers `503 {"detail":"NEON_AUTH_JWKS_URL is required"}` without auth configured — the same degraded contract as every other staff route, which is what proves the new prefix reaches the shared pipeline.

**Not done, by charter:** scheduled mode changes, per-channel modes, new modes.

## S09-01 - Request lifecycle (2.00d)

**AC (verbatim):** request_acknowledged is set by a real staff action.

- **AC-1** Legal transitions `new→acknowledged→assigned→resolved|cancelled` enforced at the DB level.
- **AC-2** `acknowledged_at` can only be set inside `withStaffSession` by a role allowed on `queue:write`.
- **AC-3** `request_acknowledged`, `request_assigned`, `request_resolved` events are emitted.

**Status: DONE (2026-10-26).** `db/migrations/0024_request_lifecycle.sql` (new), `src/requests/lifecycle.ts` (new), `src/audit/actions.ts` (4 actions + the `request` entity), `src/inbox/actions.ts` (Assign/Resolve now walk the edges), `src/staff/http.ts` (request-scoped routes + 409/404 mapping), `src/inbox/detail.ts` (status typed as the union), `web/lib/request-status.ts` (new, shared vocabulary), `web/app/(staff)/inbox/[conversationId]/{page,actions}.tsx|ts` (Acknowledge + Cancel buttons), `web/app/(staff)/inbox/page.tsx`, `web/lib/types.ts`, `src/i18n/catalog.ts` (`staff.inbox.acknowledge*`, `cancel_request`, en+es); tests `tests/db/request-lifecycle.db.test.ts` (new, 36), `tests/requests/lifecycle.test.ts` (new, 26), `tests/staff/http.test.ts` (+3), `tests/inbox/detail-page.test.ts` (+2), `tests/audit/actions.test.ts`, `tests/db/{schema,non-superuser,inbox-actions}.db.test.ts` updated for the new file.

**Before this item the status column was a suggestion.** `service_requests.status` has carried the five words since 0001, and any writer that could reach the row could set any of them. S08-03 tightened two corners (one assignment per person; `acknowledged_at` implies "not new"). Nothing stopped `new → resolved`, nothing stopped reopening a closed request, and nothing asked *who* was writing.

**0024 puts the machine in the database.** One `BEFORE INSERT OR UPDATE` trigger, `request_transition_guard`, split deliberately in two:

| concern | rule | errcode |
|---|---|---|
| **shape** (one row in isolation) | `acknowledged_by` may not sit on a row that is still `new` | `P0001` — 0018's code, 0018's family |
| **transition** (the row's history) | only `new→acknowledged`, `acknowledged→assigned`, `assigned→resolved\|cancelled` | `23514` |
| **actor** | `app.current_user_id` set *and* `current_membership_role(property_id) ∈ (1,2,3)` | `42501` |
| **evidence** | acknowledged needs `acknowledged_at` + the actor as `acknowledged_by`; assigned needs an `assignments` row; resolved needs `resolved_at` | `23514` |
| **identity** | `(org_id, property_id, request_id)` is immutable — an UPDATE cannot move a request out of the range of every tenant predicate | `23514` |

AC-2's real content is the **actor** row: the trigger does not merely check that a user GUC is non-empty, it checks the same `current_membership_role()` definer function the RLS policies and `requireRole()` already trust. So the read-only observer (role 4) is refused *by the database* even though they pass RLS on the row — which is the case a TypeScript-only check cannot cover, because a background job or a raw psql session never reaches the TypeScript.

**Two charter deviations, recorded rather than quietly taken.**

1. **One trigger, not two.** §4 proposed a separate `request_ack_guard` for the timestamp/actor shape. 0018's `service_requests_time_guard` already owns that rule for `acknowledged_at`/`resolved_at` and raises `P0001`; a second trigger for the same family would give one mistake two errcodes depending on which fired first (trigger order is alphabetical, so `request_…` beats `service_…`). The new column's shape rule lives in the new trigger and reuses `P0001`.
2. **`acknowledged_by` is not frozen after the edge.** §8 asked to "reject changes to an existing acknowledgement". It doesn't, and that is deliberate: the immutable record of who acknowledged what and when is the `audit_log` row written on the edge — the same reasoning as S08-04, where `properties` has no `updated_at` because the audit row *is* the change record. Freezing the column would duplicate that history in a place that keeps none, and it broke two existing contracts (0018's "the honest pair is accepted" insert, and the S08-01 inbox fixture, which stamps `resolved_at` on an already-resolved row). What *is* enforced is that the column can only be established on the acknowledged edge, by the actor who is signed in.

**The route.** `POST /api/inbox/requests/:id/{acknowledge|assign|resolve|cancel}`, not §4's `/staff/requests/:id/:action` — there is no `/staff` prefix; S08 established `/api/*` behind the shared identity → tenant → role pipeline. It is request-scoped rather than conversation-scoped because acknowledgement is a fact about one request, and a thread can hold several.

**Assign and Resolve had to be integrated, not bypassed.** S08-03's writers went `new → assigned` and `open → resolved` directly; a strict trigger without touching them would have broken both in production while every test stayed green. They now walk the edges through the same service:

- `assignRequest` from `new` acknowledges first, then assigns — both by the authenticated caller, so the acknowledgement is a real staff action rather than a fabricated intermediate.
- `resolveConversation` walks `new → acknowledged → assigned → resolved` for **every** open request on the thread, in the same transaction.

The consequence is honest and worth stating: resolving an untouched request attributes the acknowledgement *and* the assignment to the person who resolved it, and sets `acknowledged_at = resolved_at`. That is the truth — nobody looked at it earlier — and the audit rows name them.

**UI: a button per legal edge, never more.** 0024 answers 409 to a skipped edge, so an always-visible button is a button that reliably fails, and staff who learn one button lies stop trusting the rest of the bar. Acknowledge shows only at `new`; Assign to me at `new`/`acknowledged`; Cancel only at `assigned`. Both new actions are plain server-action forms (work before hydration, token stays in the HttpOnly cookie). The request list now renders status through the catalogue — the list screen translated these five words while the detail screen printed them raw, so the same request read differently on the two screens. `web/lib/request-status.ts` holds the vocabulary once; `REQUEST_LABEL` is `Record<RequestStatus, StringId>`, so a sixth status is a compile error until it is translated. `DetailRequest.status` and its wire mirror were `string`, which is what let the raw rendering compile — both are the union now, honest against the CHECK at 0001:157.

**Evidence (local, PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm 1.6):**
```text
$ npm run db:migrate   # 24 applied from an EMPTY database (0024 lands)
$ npm run db:test      # 34 files / 315 passed (lifecycle: 36)
$ npm test             # 44 files / 562 passed (lifecycle matrix: 26, http: +3, detail page: +2)
$ npx tsc --noEmit && npx tsc --noEmit -p web/tsconfig.json && npm run lint   # clean
$ npm run web:build    # green; /inbox/[conversationId] in the manifest
```

**The 36 DB cases are mostly raw SQL.** The service already refuses an illegal edge and `tests/requests/lifecycle.test.ts` proves that; the database suite exists because a TypeScript refusal is only a refusal for callers that go through the TypeScript. Each illegal pair is attempted with a *valid* queue-write actor and a hand-built `UPDATE` that never imports the service — the shape a background job or a psql session takes — and the assertion is both the errcode and that the row did not move. The actor cases drop `app.current_user_id` entirely, or set it to the observer, and assert `42501` with the status unchanged.

**Not done, by charter:** email delivery (S09-05), knowledge-gap queue (S09-02), reassignment to a colleague from the UI, a `request_cancelled` event (the taxonomy has no such name — cancellation is audit-only).

## S09-02 - Knowledge-gap queue (0.50d)

**AC (verbatim):** Every no_answer lands in the queue automatically.

- **AC-1** Each `no_answer` creates/updates one `knowledge_gaps` row with the verbatim question, language and property.
- **AC-2** Close produces `knowledge_gap_closed`; median age is computable.

**Status: DONE (2026-10-26).** `db/migrations/0025_knowledge_gap_queue.sql` (new), `src/gaps/queue.ts` (new), `src/ai/answer.ts` + `src/requests/capture.ts` (both now call the one writer), `src/audit/actions.ts` (`knowledge_gap.closed` + the `knowledge_gap` entity), `src/staff/http.ts` (`/api/gaps` routes) + `src/server.ts` (wiring), `web/app/(staff)/gaps/{page.tsx,actions.ts}` (new), `web/app/(staff)/layout.tsx` (nav), `web/lib/types.ts`, `src/i18n/catalog.ts` (`staff.gaps.*`, en+es); tests `tests/db/gaps.db.test.ts` (new, 21), `tests/gaps/page.test.ts` (new, 5), `tests/audit/actions.test.ts`, `tests/db/{schema,non-superuser}.db.test.ts` updated for the new file.

**The gap table already existed and already had two writers — that was the bug, not the missing feature.** `knowledge_gaps` is in 0001, and since S05-02/S07-03 both `src/ai/answer.ts` (empty retrieval, and the model's own `no_answer`) and `src/requests/capture.ts` (riding along with a `no_answer` request) inserted into it. Capture guarded against double-writing with a lookup scoped to the **conversation**, so the same question asked by a second guest was a second row. The result was a queue that showed one entry per guest instead of one per question, and threw away the only number that tells a content owner what to write first.

**0025 makes the row a queue entry.** One open row per distinct unanswered question per property, plus:

| column / index | why |
|---|---|
| `hits integer NOT NULL DEFAULT 1` | how many guests hit the miss |
| `topic text` | carried from the request, filled in on a later ask if the first did not know it |
| `question_key` generated | the dedupe key (see the two traps below) |
| `UNIQUE (property_id, question_key) WHERE status='open'` | one open entry per question; *partial*, so closing a gap lets the same question be recorded again |
| `(property_id, status, created_at DESC)` | the queue query |
| `CHECK (resolved_at IS NULL OR status='resolved')` | the same rule 0023 added for requests: the median reads `status`, so `resolved_at` may not contradict it |

`recordGap` is the single upsert. `capture.ts` calls it instead of inserting, and no longer emits `knowledge_gap_created` — `recordGap` emits it only for a row it actually created, so a repeat ask is a count and not an event.

**Trap 1 — a btree key cannot hold a guest message.** The obvious index is `lower(question)`. A btree key is capped at ~2704 bytes and `MAX_MESSAGE_CHARS` is 2000 *characters*, so a guest typing 2000 accented or CJK characters is ~4000 bytes: the INSERT would fail, meaning **a guest who writes a long question breaks their own reply**. `question_key` is therefore `left(…, 400)` — capped at 1600 bytes worst case. The question column keeps the guest's exact text; only the matching key is truncated. `tests/db/gaps.db.test.ts` drives a 1600-character question through the real guest route to hold that line.

**Trap 2 — `lower()` is not case folding.** Found by testing the migration's merge branch on a real database: `lower('¿A QUÉ HORA')` returns `'¿a quÉ hora'` under a C/POSIX collation. ASCII folds, accented capitals do not. So a shouted Spanish question would open a *second* queue entry next to the same question asked normally — on one deployment and not another, depending on a locale flag nobody sets deliberately. For a product whose working language is Spanish that is the common case, not the corner. `question_key` now runs `translate(question, 'ÁÉÍÓÚÜÑÇ', 'áéíóúüñç')` before `lower()`, which is locale-independent. There is a test for it, because "simplify the generated column to plain `lower()`" looks like a tidy-up and is a behaviour change.

**One ask per turn, not per writer.** A no-answer turn reaches `recordGap` twice by design — the pipeline records the miss, then capture links the escalation to it — both inside the one guest transaction. Counting both would make `hits` exactly double the guests who asked, which is the kind of wrong that looks plausible on a dashboard for months. The upsert increments only when the existing row's `xmin` is not the current transaction:

```sql
hits = knowledge_gaps.hits + CASE
         WHEN knowledge_gaps.xmin = pg_current_xact_id()::xid THEN 0 ELSE 1 END
```

`xmin` is the transaction that wrote the row, so "written by the transaction I am in" is the precise test for "already counted this turn". A later turn — same guest tomorrow, or a different guest — has a different `xmin` and increments. `(xmax = 0)` in the `RETURNING` distinguishes a real insert from a conflict-update, which is what decides whether `knowledge_gap_created` may fire. Both primitives were probed against PostgreSQL 16.2 before being relied on.

**The migration deletes rows, on purpose.** The unique index cannot be created while two open rows share a key, and on a database running since S05-02 they do. So duplicates are merged first: the **oldest** row survives (its `created_at` is the honest "how long has this gone unanswered"), the others are folded into `hits`. The duplicates are not distinct history — they are one event recorded twice by two writers — and keeping them would keep the double-count this item exists to remove. `knowledge_gap_created` events already emitted for a deleted row stay in `events`; their payload names a `gap_id` that no longer resolves, which is the normal fate of a log entry outliving its subject.

**Verified against a real pre-0025 database, because the test suite never reaches that branch.** Every scratch database is built from empty, so the merge's `HAVING count(*) > 1` never fires in CI. Applied 0001–0024 to a fresh database, seeded the shape the two writers actually leave behind, then applied 0025:

```text
before: 7 rows  (3× "¿A qué hora es el desayuno?" open at 9/5/1 days,
                 1× the same SHOUTED, 1× the same resolved at 30 days,
                 1× "¿Hay gimnasio?" open, 1× "  ¿Hay gimnasio?  " open)
after:  3 rows  desayuno open  hits=4 age=9d  (all four folded, oldest kept)
                desayuno resolved hits=1 age=30d (untouched — partial merge)
                gimnasio open  hits=2 age=7d  (whitespace variants folded)
```

**That check found a second bug the runner was hiding.** The merge used `CREATE TEMPORARY TABLE gap_merge ON COMMIT DROP`. Under `src/db/migrate.ts` each file is one transaction, so it works — but run the same file statement-by-statement (`psql -f` in autocommit, a restore, a manual hotfix, any tool that does not know this repo's convention) and each statement commits, the table is dropped immediately, and the migration dies at the UPDATE **after the ALTERs have already landed**: a half-migrated database, which is worse than a clean failure. `ON COMMIT DROP` is gone; a temporary table is dropped at session end anyway, so nothing was given up.

**Median, not mean.** `percentile_cont(0.5)` over `now() - created_at` for open rows, in SQL. A mean is dragged by the one gap nobody has touched since launch; a page is not the population. Appendix D's target is ≤7 days, so the screen colours the median against it and says the target out loud — a number with no target is a number nobody acts on. An empty queue reports `null`, not `0`: zero would read as a measurement of nothing.

**Surface.** `GET /api/gaps` (`knowledge: read`) and `POST /api/gaps/:id/close` (`knowledge: write`), its own prefix rather than a branch of `/api/inbox` because the two have different role matrices — a front desk works the inbox and may only *read* the gaps, since closing is a claim that the content now exists. The screen is a server component with links and forms like the inbox: oldest-first (because `hits` is mutable and keyset pagination over a moving key repeats and skips rows), `hits` and age on every row, the question verbatim as a JSX child, and a link through to the conversation that first asked it.

**Evidence (local, PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm 1.6):**
```text
$ npm run db:migrate   # 25 applied from an EMPTY database (0025 lands)
$ npm run db:test      # 35 files / 336 passed (gaps: 21)
$ npm test             # 45 files / 567 passed (gap screen: 5)
$ npx tsc --noEmit && npx tsc --noEmit -p web/tsconfig.json && npm run lint   # clean
$ npm run web:build    # green; /gaps in the manifest
```

AC-1's primary assertions drive **real guest turns** through `postGuestMessage` against a property seeded with no articles, so an empty retrieval is the no-answer and the stub provider is never consulted. A test that called `recordGap` directly would prove the function works and not that the pipeline calls it — and "automatically" is the whole AC.

**Not done, by charter:** the gap analytics tile (S10-03), a "write the article from here" flow into the review queue, gap re-opening by hand (a repeat ask reopens it), per-topic grouping.

## S09-03 - One-click 'wrong or outdated' (0.50d)

**AC (verbatim):** A flag is attributable to an ai_run.

- **AC-1** One click creates a flag row with `ai_run_id`, staff user id, timestamp and optional note.
- **AC-2** The flag is visible on the conversation detail view and emits `answer_flagged_wrong`.

**Status: DONE (2026-10-26).** `db/migrations/0026_answer_flags.sql` (new), `db/erd.mmd`, `src/inbox/flags.ts` (new), `src/inbox/detail.ts` (flags ride with each run), `src/audit/actions.ts` (`answer.flagged` + the `ai_run` entity), `src/staff/http.ts` (`POST /api/inbox/answers/:aiRunId/flag`), `web/app/(staff)/inbox/[conversationId]/{page.tsx,actions.ts}`, `web/lib/types.ts`, `src/i18n/catalog.ts` (`staff.flag.*`, en+es); tests `tests/db/flags.db.test.ts` (new, 16), `tests/inbox/detail-page.test.ts` (+3), `tests/db/{isolation,schema,non-superuser}.db.test.ts`, `tests/audit/actions.test.ts`.

**Attribution is the whole AC, and it is what makes the flag useful later.** A flag pointing at a run supports per-model accuracy, per-prompt-version regressions, and "the answer that cited this article version was called wrong nine times". A flag attached to a message, a conversation, or a run id inside a JSONB payload supports none of them. So `ai_run_id` is `NOT NULL` and the run is read back inside the caller's transaction before the insert.

**The composite FK is the security property.** `FOREIGN KEY (org_id, property_id, ai_run_id) REFERENCES ai_runs (org_id, property_id, ai_run_id)`. A bare `ai_run_id → ai_runs(ai_run_id)` would let a row name a run that exists — in somebody else's property. RLS would then *hide* it, but hidden is not refused: the insert would succeed, the flag would be orphaned from every query that reads it, and the failure would stay invisible until somebody noticed a count that never moved. `tests/db/flags.db.test.ts` bypasses the application entirely — raw `INSERT` as `concierge_app` with tenant A's GUCs naming tenant B's run — and asserts the row is refused.

**One flag per person per answer.** `UNIQUE (org_id, property_id, ai_run_id, flagged_by)`. A second click is a phone on a bad connection, not a second opinion, so the service reports `created: false` and writes no second event or audit row. Nine flags from one person would read as nine people — the same inflation the gap queue's `hits` exists to avoid. Two *colleagues* flagging is two flags, because it is two people.

**Append-only, and the grant that did not do what it looked like it did.**

0026 was written `GRANT SELECT, INSERT ON answer_flags TO concierge_app` — the same shape as an audit trail, no UPDATE, no DELETE, so a disputed flag could not be quietly withdrawn. The test asserted that instead of assuming it, and **the UPDATE succeeded**. The reason is in 0002:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO concierge_app;
```

Every table created since 0002 already has all four before its own migration says anything, and a `GRANT` is *additive* — listing two privileges does not withdraw the other two. `\dp answer_flags` after only the grant reads `concierge_app=arwd`. The append-only design would have been a comment, not a constraint, and the test that would have caught it is the one I nearly did not write.

The fix follows the repo's own precedent: `0007_audit_privileges.sql` is a whole migration consisting of `REVOKE UPDATE, DELETE ON audit_log FROM concierge_app`, which is why `audit_log` reads `concierge_app=ar`. 0026 now revokes, and also adds 0003's `raise_immutable()` trigger — the REVOKE binds `concierge_app`, but the migration role and any future grantee can still write, and `events`/`audit_log` are trigger-protected for exactly that reason. Both tables now read `ar`:

```text
   relname    |                        relacl
--------------+-------------------------------------------------------
 audit_log    | {postgres=arwdDxt/postgres,concierge_app=ar/postgres}
 answer_flags | {postgres=arwdDxt/postgres,concierge_app=ar/postgres}
```

**The consequence for the UI: the note cannot be added later.** AC-1 says "optional note" without saying when, and append-only answers it — there is no "attach a note to the flag I filed a minute ago". So the optional note input sits in the *same form* as the button, and one click still means one click: the field may be left blank, and a blank field is omitted rather than sent as an empty string (the service 400s on whitespace-only, because an empty note says nothing and costs a column).

**Whose name is on it.** `flagged_by` is stored and is the attribution the AC asks for. It cannot be *displayed* as a name for anybody but the caller: 0004's `users.staff_select` policy authorises your own row only, so a join for a colleague's `display_name` returns NULL for everyone else. Widening that policy would expose staff names and emails across a property — an S02 security decision, not something to slip into a 0.5d item. So the wire carries `flaggedBy` (UUID) and `mine`, and the screen shows how many people flagged an answer, the notes they left, and whether you are one of them. A test asserts the flag object's exact key set, so widening it later is a deliberate act rather than an accident.

**The indicator is on the answer, not beside it.** A screen that shows an answer and a separate roster of complaints invites reading one without the other, which is how a wrong answer keeps being trusted by the next person who opens the thread. The button disappears once you have filed one, because the schema refuses a second and a button that reliably fails teaches staff that the screen lies (the same rule as S09-01's action bar).

**Three drift guards caught the new table, and each earned its keep.** `tests/db/isolation.db.test.ts` derives the tenant-table list *from the database's own policies* and compares it to the declared one; `tests/db/schema.db.test.ts` checks the migration list, the table count, and that the committed ERD in `db/erd.mmd` matches reality; `tests/db/non-superuser.db.test.ts` counts applied migrations. All three failed until `answer_flags` was declared, seeded in both tenants, and drawn. Adding it to the isolation list made the cross-tenant sweep cover it for free — zero rows without context, and no leak in either direction.

**Evidence (local, PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm 1.6):**
```text
$ npm run db:migrate   # 26 applied from an EMPTY database (0026 lands)
$ npm run db:test      # 36 files / 352 passed (flags: 16)
$ npm test             # 45 files / 570 passed (detail page: +3)
$ npx tsc --noEmit && npx tsc --noEmit -p web/tsconfig.json && npm run lint   # clean
$ npm run web:build    # green; /inbox/[conversationId] in the manifest
```

**Not done, by charter:** the review queue that consumes flags (S09-04); retraining or automated fixes; retracting a flag (would need its own column or a new row, not the ability to delete this one); flag counts surfaced on the review screen or in analytics (S10-03).

## S09-04 - Non-blocking review queue (0.50d)

**AC (verbatim):** Flagging an answer does not delay the guest reply.

- **AC-1** The outbound guest message is committed before any review/flag work starts.
- **AC-2** Review work is retried from the outbox on failure; a failure never re-sends the guest message.

**Status: DONE (2026-10-26).** `db/migrations/0027_answer_review_outbox.sql` (new), `db/erd.mmd`, `src/review/queue.ts` (new), `src/ai/answer.ts` (`aiRunIdFor`), `src/guest/service.ts` (enqueue in the turn), `tests/db/review-queue.db.test.ts` (new, 16), `tests/review/queue.test.ts` (new, 6), `tests/db/{schema,isolation,non-superuser}.db.test.ts`.

**`outbox` has existed since 0001 with `status`, `attempts`, `next_attempt_at`, `last_error` and `processed_at`, and nothing had ever read it.** This is its first consumer, so it sets the conventions the later ones inherit — S09-05's email and S11-01's worker — rather than each inventing its own idea of a retry.

**The guarantee is not "review is fast", it is that review is not on the guest's path at all.** The turn writes the reply and an outbox row in ONE transaction and commits; only then can anything read the row. So slow, broken or absent review machinery cannot delay a reply (the guest is already answered), there is no window where the reply exists and the review work was lost, and none where review work survives a rolled-back reply. AC-2's "never re-sends" is **structural**: `src/review/queue.ts` touches `outbox` and `answer_reviews` and nothing else — it holds no provider, no channel adapter and no reference to `insertMessage`, so there is no path by which a retry could produce a second guest message. The test counts outbound messages across a failure, a retry and a replay anyway, because "cannot" is a claim worth checking.

**Enqueueing cannot break the reply either.** `enqueueReview` runs inside the guest's transaction, so any error it raised would roll the reply back — the opposite of AC-1. It uses `ON CONFLICT … DO NOTHING` against a partial unique index rather than a read-then-insert, so the statement cannot raise on a duplicate and there is nothing to catch inside somebody else's transaction (no savepoint needed). The index is partial on `status IN ('pending','sending','failed')`, so a finished row does not block a future one and a `dead` row can be re-queued by hand.

**Three bugs this item found, none of them visible from reading the code.**

1. **`SECURITY DEFINER` does not bypass RLS.** The cross-tenant claim was a definer function owned by a new NOLOGIN `concierge_worker` role, with the right table privileges. It ran, and returned **zero rows**: `outbox` is FORCE RLS whose policy reads `current_org_id()`, and at claim time no tenant GUC is set — setting them per row *after* claiming is the whole point. An empty queue looks exactly like a healthy one, so this would have shipped as a review queue that silently never reviewed anything. BYPASSRLS is not available (it needs a superuser, which is why 0015 went the narrow-role route for the guest slug lookup), so `concierge_worker` gets its own permissive policy on `outbox`, split `FOR SELECT` and `FOR UPDATE` rather than one `FOR ALL` because `SELECT … FOR UPDATE` is checked against both and a blanket policy would advertise INSERT and DELETE the table privileges already refuse. Contained the way 0015 contains `concierge_public`: NOLOGIN, not a member of anything the app can `SET ROLE` into, no grants on any other tenant table, reachable only through the one function.
2. **`SELECT … FOR UPDATE SKIP LOCKED` needs the UPDATE privilege.** `concierge_worker` had `GRANT SELECT ON outbox` and the claim failed `permission denied for table outbox`. Locking a row for writing requires UPDATE even when the statement writes nothing — and "SELECT needs SELECT" is exactly the assumption that looks right.
3. **`ALTER FUNCTION … OWNER TO` needs `SET ROLE` membership under a non-superuser.** On Neon the migration role is the deployed login role, not a superuser, so transferring the claim function to `concierge_worker` failed with `must be able to SET ROLE "concierge_worker"`. `tests/db/non-superuser.db.test.ts` — which exists precisely to run the chain as a non-superuser owner — caught it. Fixed with 0015's idiom (`GRANT concierge_worker TO current_user` via `format`, for the duration) plus 0005's reason for revoking it immediately after: a login role that stays a member of a definer role can `SET ROLE` into it and reach whatever permissive policy that role has, which here is *every tenant's outbox*. `EXECUTE` goes to `concierge_app` only and deliberately not to `CURRENT_USER` the way 0009 does, because the worker always switches roles first and granting it would let a session that forgot claim across every tenant.

**The disposition rule §4 implied cannot exist, and finding that out is the item's most useful negative result.** The obvious reading of S08-04 is "in `draft` mode every answer needs a human", so `needs_review` should be true in draft mode. It can never be true: draft mode escalates with **zero provider calls** (S08-04's own evidence table), so there is no `ai_runs` row to dispose of. Draft mode's queue is the inbox, where a human writes the reply. A rule that cannot fire is not a rule, and shipping it would have produced a table that is always `false` and looks like it is working.

What shipped instead reads one column the pipeline already writes, `ai_runs.decision`, so it invents no policy and no threshold (`settings` has no confidence floor, and adding one here would be a second undocumented policy hiding inside a plumbing item):

| `ai_runs.decision` | `needs_review` | reason |
|---|---|---|
| `answer` | no | `answered` — it went out, guardrails passed, citations reconstructed |
| `escalate` | **yes** | `escalated:<reason_code>` — a human was asked for *after* the model was consulted |
| `no_answer` | no | `no_answer_owned_by_gap_queue` — S09-02 already holds the verbatim question and the hit count |

`aiRunIdFor` is exhaustive over `AnswerOutcome` with no `default`, for the same reason `requestTopicFor` is: a new outcome kind that forgets to declare itself is a compile error rather than an answer that silently never reaches the queue. Its two `null` branches are not oversights — a `fact` called no model, and a no-answer on the empty-retrieval path records no run at all.

**Failure handling.** Exponential backoff 1s→2s→4s→8s→16s capped at a minute, `dead` after `REVIEW_MAX_ATTEMPTS` (5). A claim a worker ignores because `next_attempt_at` is in the future is asserted behaviourally — the worker declines the row — rather than as a clock window, which would flake on slow hardware. `dead` rows keep their `next_attempt_at` so "when did we give up" is answerable from the row and not from a log nobody has. No jitter, and that is a recorded gap rather than an oversight: with one worker there is nothing to thundering-herd, and S11-01 runs more than one.

**One row per transaction, and that is load-bearing.** `FOR UPDATE SKIP LOCKED` holds its lock only for the duration of the transaction that took it, so a batch claimed up front would be unlocked again before any of it was processed and a second worker would claim the same rows. Claiming inside the work transaction also means this loop never writes `status = 'sending'`, so it cannot strand a row a dead worker was holding — the failure mode S11-01's reaper exists for. A review whose run has been deleted (its conversation cascaded) is marked `sent` rather than retried, because burning five attempts toward `dead` over a row that will never come back is an alert about nothing.

**§4's timing test was replaced.** It asked for "delta <10ms with and without a failing review worker". A wall-clock delta under 10ms is not a property this can guarantee on shared CI hardware and would flake; what it was a proxy for is *ordering*, and that is what is asserted: from a session that was not part of the turn, the reply is visible while the review row is still `pending` with `processed_at IS NULL` and no disposition written — the review work provably has not started.

**Failure is injected by revoking a privilege**, not by telling a stub to throw: `REVOKE INSERT ON answer_reviews FROM concierge_app`, run the worker, get a real `42501`, then grant it back. The retry is the same code path a deploy would take.

**Evidence (local, PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm 1.6):**
```text
$ npm run db:migrate   # 27 applied from an EMPTY database (0027 lands)
$ npm run db:test      # 37 files / 368 passed (review queue: 16)
$ npm test             # 46 files / 576 passed (pure queue: 6)
$ npx tsc --noEmit && npx tsc --noEmit -p web/tsconfig.json && npm run lint   # clean
$ npm run web:build    # green
```

**Not done, by charter:** the worker is not scheduled — `processReviewOutbox` is implemented and tested but nothing calls it in production; S11-01 owns its lifecycle (interval, shutdown, concurrency, the `sending` reaper). Also out: a review screen for `answer_reviews` (the flags from S09-03 are already on the conversation detail, and the gap queue from S09-02 has one); email (S09-05); jitter and worker metrics.

## S09-05 - Email notifications (0.50d)

**AC (verbatim):** A request reaches a human even when nobody has the staff view open.

- **AC-1** Every new/acknowledged request enqueues an email to the property's escalation contacts.
- **AC-2** Recipients come from `settings.escalation.contacts`; a property with no email contacts falls back to a configured address; provider failure retries via the outbox and never loses the notification.

**Status: DONE (2026-10-26), except delivery evidence — see the last section.** `db/migrations/0028_email_outbox.sql` (new), `src/notifications/email.ts` (new), `src/providers/email.ts` (new), `src/requests/capture.ts` + `src/requests/lifecycle.ts` (enqueue), `src/guest/service.ts` (message pointer), `src/i18n/catalog.ts`, `src/audit/actions.ts`, `.env.example`, `tests/notifications/email.test.ts` (new, 34), `tests/db/email-outbox.db.test.ts` (new, 27), `tests/db/{schema,non-superuser}.db.test.ts`, `tests/db/request-lifecycle.db.test.ts`, `tests/audit/actions.test.ts`.

**DEC-4 (operator, 2026-10-26):** provider is **Resend**, reached over plain `fetch` with no SDK — a transactional-email API is one POST with a bearer token, and an SDK here would be a supply-chain surface for forty lines. That keeps the standing "no new runtime dependency" rule intact; `qrcode` remains the only sanctioned addition.

**The queue row is written inside the request's own transaction, and that is the whole guarantee.** The alternative — a service that polls for recent requests — has a window where the request exists and nothing has decided to send mail yet. A crash in that window is a guest who asked for a person and got silence, and it is *invisible*: nothing records the absence. Queueing in the same commit makes "the request exists" and "somebody will be told" one atomic fact, so a rollback takes the notification with it and a commit makes it visible to a session that was not part of the turn. Both halves are asserted.

**Two notifications, not one per status change.** `new` (a guest asked for a human) and `acknowledged` (a human said "I have this") are queued; `assigned`, `resolved` and `cancelled` are not. Those are already visible in the inbox to anyone looking, and emailing every edge turns the escalation channel into noise — which is how the one notification that mattered gets filtered along with the rest. The dedupe key is therefore `request_id:stage`, not `request_id`: keying on the request alone would silently swallow the acknowledgement, the more actionable of the two.

**The payload carries pointers, never the email.** `claim_outbox` is `SECURITY DEFINER` and returns `payload` *before any tenant context exists*, because that is the one read a worker cannot do under RLS. So anything placed in the payload is on the only cross-tenant surface in this flow. The guest's words stay in `messages.body`, behind the tenant policy, and are read after the GUCs are set — asserted by pinning the payload's exact key set and checking that a distinctive guest phrase appears nowhere in it. That has a second, better consequence: recipients are resolved at **send** time, not enqueue time, so a property that adds a contact between the request and a retry reaches that person instead of the fallback, and a settings change needs no re-queueing.

**The subject carries the property and the request id and nothing else (§7).** A subject is stored on the outbox row, indexed by a third party's mail infrastructure, legible on a locked phone's notification banner, and retained in the provider's logs. The guest's own words belong in the body, which goes only to people who could already open that conversation in the console. `captureRequest`'s existing comment on `question` says the same thing from the other direction — guest text does not ride on a queue row because it "ends up in a digest, an email subject and a support ticket".

**The fallback address is redacted, and that is a security decision rather than a nicety.** `EMAIL_ESCALATION_FALLBACK` is deployment-wide, not tenant-scoped, so a property that configured no contacts still gets its escalation delivered — but the body carries the request id and the console link and *not* the guest's message. Forwarding one property's guest conversation to an address outside that property's access boundary would be a disclosure. The composer picks a `redacted_notice` block instead of the quote block, and the audit row records `recipientSource: "fallback"` with `redacted: true`, so "the fallback was used" is evidence rather than a guess.

**No hardcoded fallback, anywhere.** DEC-4 was explicit that the operator names the address. `EMAIL_ESCALATION_FALLBACK` is required outside `APP_ENV=local` and refuses boot when absent, on the same rule `loadBotCheckConfig` and `loadGuestConfig` already apply: a control that is "on in production if someone remembered" is off. A default address in the repository would collect every tenant's escalations forever, whether or not anyone still reads it. `EMAIL_FROM` is required in *every* environment for the same reason — a default sender is a published one, and every deployment that forgot would send from the same domain.

**Nobody to send to is loud, never quiet.** `resolveRecipients` returns `source: "none"` when a property has no `email` contacts and no fallback is configured; the worker marks the row `dead` with `last_error` naming `no_recipient` and writes `notification.dead`. It does *not* retry, because nothing about the property's settings changes between attempt one and attempt two. Silently succeeding here would be the worst outcome in the file: the guest asked for a person and the system would record that it handled it. `in_app` contacts do not count as addresses — the inbox is a different delivery path, and emailing an in-app handle means sending to a string that is not an address, which the provider would reject five times before going dead.

**Failure handling distinguishes "worth another try" from "will refuse identically forever".** A 5xx, a 429 or an unreachable provider is retryable; a 4xx is permanent and goes straight to `dead` on the *first* attempt. Burning five retries on a rejected sender domain or an invalid key produces a `dead` row that looks exactly like an outage and sends the operator looking in the wrong place. 429 is special-cased as retryable despite being a 4xx: dropping notifications precisely when the property is busiest would be the worst possible moment to treat a rate limit as permanent. Backoff is the review worker's ladder (1s→2s→4s→8s→16s, capped at a minute, `EMAIL_MAX_ATTEMPTS` 5) so there is one retry shape to reason about.

**A dead row carries no `next_attempt_at`, deliberately differing from the review worker.** `next_attempt_at` means "next eligible for claiming", so leaving a timestamp on a row that will never be claimed again reads as a *missed retry*. Both email paths set `processed_at`, which is the column that actually answers "when did we give up". S09-04's `recordFailure` stamps a due-time on dead rows only because it writes no `processed_at` and needs some give-up timestamp; rewriting that in an S09-05 commit would be out of scope, so the difference is documented in both places instead of being left to be discovered.

**`BEGIN` is load-bearing, and omitting it fails invisibly.** `claim_outbox` ends in `FOR UPDATE SKIP LOCKED`, and that lock lives exactly as long as the transaction that took it. Without an explicit `BEGIN` every statement is its own transaction, the lock is released the instant the claim returns, and two workers can claim the same row and both send it. `COMMIT` with no open transaction *succeeds with a warning*, so a single-worker test passes and the bug surfaces in production as duplicate escalation emails. The worker now mirrors S09-04 exactly: `BEGIN`, `SET LOCAL ROLE concierge_app`, claim, set tenant GUCs transaction-locally, work, commit — with failure bookkeeping in its own transaction, because the one that failed was rolled back and recording an attempt inside it would record nothing.

**0028 generalised the claim instead of adding a second one.** 0027 shipped `claim_review_outbox(integer)` hardcoded to `kind='review'`. A definer function per kind is a cross-tenant *window* per kind — each one another place to get the policy wrong — so 0028 adds `claim_outbox(p_kind text, batch_limit integer)` and drops the old one. Same NOLOGIN owner, same two narrow policies, same grant-then-revoke membership around `ALTER FUNCTION … OWNER TO`, same `REVOKE ALL … FROM PUBLIC` afterwards (owner transfer discards the ACL and restores `EXECUTE` for PUBLIC). `EXECUTE` goes to `concierge_app` only. S11-01's workers inherit one primitive rather than N.

**Two Postgres traps this item hit.**

1. **`jsonb_build_object` is variadic `"any"`, so Postgres cannot infer a parameter's type from it.** The insert failed to plan with `could not determine data type of parameter $3` — the dedupe key, used only inside the builder. Every value is now explicitly cast, which also pins `message_id` as a real uuid-or-null rather than a string that happens to look like one.
2. **A backtick inside a SQL comment terminates the surrounding JS template literal.** esbuild reported `Expected ")" but found "next_attempt_at"` at a line that was pure comment. The same trap S09-02 hit; the file now has no backticks in any SQL comment.

**Two test-isolation bugs the first run exposed, both worth recording because they look like product bugs.** `captureRequest` *reuses* an open request per conversation — one problem, one request — so every test after the first got `created: false` and queued nothing at all, and `processed: 1` came back `0`. And `messages.conversation_id` is an FK, so a message seeded on a property's original conversation cannot be attached to a request on a different one. Each capture now opens its own conversation, and a `beforeEach` empties the email queue: the worker claims across every tenant, so a row an earlier test left pending would be processed by a later one and every tally assertion would be a lie about a different test's data.

**The acknowledging colleague is named by role, never by name.** 0004's `users.staff_select` policy authorises your own row only, so a worker cannot read a colleague's `display_name` — and an email composer is no place to quietly widen that (it is an S02 security decision). The catalogue string is "A member of our team" / "Un miembro de nuestro equipo"; the console shows who.

**Audit.** Three actions added to the closed list: `notification.queued` (AC-1's evidence, and it outlives the outbox row being marked sent), `notification.sent` (carries the provider's own id — delivery evidence that is not ours to invent — plus `recipientSource`, a recipient *count* and `redacted`; never an address, because an address is PII and `assertSafeDetail` is not the only reason to keep it out), and `notification.dead` (the escalation failed, with the reason). Actor is the staff member on the acknowledged edge and `null` on the guest edge and on every worker write: attributing a system action to a person is a false record.

**Review round 1 (PR #145) — four findings, all fixed, all previously untested.**

The reviewer's framing was the useful part: these were not bugs the tests caught and
then failed to fix, they were bugs the tests could not see. Each one now has a case.

1. **`CONSOLE_BASE_URL` was optional outside local, so production could silently link
   to `http://localhost:3000`.** The default *resolves* — on the recipient's own
   machine, to whatever they happen to be running there. That is worse than no link:
   it looks like a working console link in a test send and fails for every real
   recipient, at 3am, on the one email whose whole purpose is to be actionable. Now
   required outside `APP_ENV=local` on the same rule as `EMAIL_API_KEY`, and the local
   default is kept because in local the link genuinely points at the developer's own
   machine.
2. **The provider timeout stopped before the body was read.** `fetch` resolves as soon
   as the response *headers* arrive; the body is a separate stream. The `finally`
   cleared the timer at that point, leaving `response.text()` with no deadline at all,
   so a provider that sends headers and then stalls the body hangs the worker forever
   — and it hangs *while holding a database transaction and a `FOR UPDATE` row lock*,
   so one stalled body pins an outbox row no other worker can claim. The timeout now
   covers the body read, and an abort mid-body is reported as `timeout` rather than as
   a success. Tested with a `ReadableStream` that delivers headers and never enqueues.
3. **The retry path could deliver twice, and the comment claimed otherwise.** The code
   said the 0028 dedupe key "stops a retry that DID land from becoming a second
   email". That was false, and the falseness is the interesting part: the index
   prevents a second *outbox row* for one request+stage. It does nothing about a second
   *delivery* of the row that already exists. If Resend accepts the email and the
   response is lost — a stalled body, a reset connection, a process killed before the
   `sent` commit — the row is still claimable and the next attempt sends it again.
   Fixed with Resend's `Idempotency-Key` header (supported on `POST /emails`, 24-hour
   window, same key + same payload replays the original response instead of
   delivering). The key is `emailIdempotencyKey(outboxId)`: **stable across every retry
   of one row, distinct between rows.** Both halves matter — a key regenerated per
   attempt builds idempotency that is idempotent against nothing, and a key derived
   from the *dedupe* key would silently suppress an operator's deliberate re-queue of a
   dead row for Resend's whole 24 hours. The retry ladder totals about fifteen seconds,
   so the key cannot expire mid-retry.
   Resend's two 409s are handled distinctly, because they mean opposite things:
   `concurrent_idempotent_requests` (the first attempt is still in flight) is
   retryable — backing off is exactly what it asks for; `invalid_idempotent_request`
   (same key, different payload) is **not** retryable and is **not** reported as sent.
   It means an earlier attempt was accepted with content that is not what we would send
   now, so claiming `sent` would assert a delivery whose content we cannot prove, and
   retrying 409s forever. It becomes a dead row with reason `conflict_payload` for a
   human to look at. That needs the property name, contacts or message to change
   between attempts, so it is rare — but rare and unexplained is exactly the
   combination that costs an afternoon.
   Making this testable required one addition to the log-only provider: an `attempts`
   list recording every message handed to `send`, failures included. `sent` alone
   cannot prove the property that matters, because a failed attempt records nothing
   there and the first key would be unobservable.
4. **A detached conversation got a broken console link.** 0001 sets
   `service_requests.conversation_id` to NULL when the conversation is deleted and the
   request row survives. The worker comment claimed the link was omitted in that case;
   the composer unconditionally appended the "Open it in the console" block, so the
   email went out with a link ending in `/inbox/`. The conversation line is now its own
   catalogue block with a `no_conversation` variant, and the link block is dropped
   entirely — the email still names the request, the property and the guest's words,
   and says the conversation is no longer available.

**A test flake CI caught that local did not, and the arithmetic is the lesson.**
`db-test` failed on the first CI run of the review fixes:

```text
AssertionError: expected '{"stage":"new","dedupe_key":"b3c1a9b2…' not to contain '402'
Received: {"stage":"new", …, "conversation_id":"5b402b98-b6a3-47c9-9290-4da409d95dce"}
```

The assertion proving the guest's words never enter the cross-tenant payload used the
bare room number `"402"` as the thing that must be absent. But the payload is mostly
random UUIDs, and **hex contains digits** — `conversation_id` began `5b402b98`, so the
substring was there legitimately. The test was asserting that four random UUIDs happen
not to contain a particular three-character hex sequence.

Probability per run: 4 UUIDs x roughly 30 start positions x (1/16)^3 ≈ **3%**. That is
why it passed every local run — including fifteen in a row while developing it — and
failed on the first CI run. A 3% flake is worse than a reliable failure, because it
survives review and then fails on someone else's commit.

Fixed by asserting a *phrase* — `"habitación 402"` — which contains a space and an
accented letter and therefore cannot occur in a UUID. Every other absence assertion in
the file was audited for the same collision and is safe (all contain spaces, accents,
`/`, or non-hex letters). Confirmed with 15 consecutive clean runs, each generating
fresh random UUIDs.

**The general rule:** never assert the absence of a short alphanumeric token from a
string that contains generated ids. Assert the absence of something that could only
come from the data you are worried about.

**Review round 2 (PR #145) — one consistency nit, and the interesting part is that the
documentation was right and the code was wrong.**

The reviewer noticed `emailBackoffMs(1)` returned 2 seconds while the review worker's
first delay was 1 second, and that both the function's own comment and this runbook
described a 1, 2, 4, 8, 16-second ladder. Three separate places already said "one
second first": the comment, this runbook's "totals about fifteen seconds", and
`src/providers/email.ts`'s argument that the ladder is short enough for a Resend
idempotency key not to expire mid-retry. Even the test's own name said *"doubles from a
second"* while its assertions started at 2000.

So the fix was to align the calculation, not the prose: `2 ** attempt` became
`2 ** (attempt - 1)`, making the two functions' expressions character-identical. That
also makes the fifteen-second claim arithmetically true — 1+2+4+8 = 15s, where
2+4+8+16 = 30s.

**Why no test caught it, and the guard that now does.** Every wrong value was plausible
in isolation: 2000 ms is a perfectly reasonable first backoff, and the old test asserted
`emailBackoffMs(1)).toBe(2000)` and passed. Single-value assertions pin whatever the
code currently does; they cannot express "these two channels agree". The new test
compares the functions to each other across the whole ladder, which turns the comment's
claim into an executable one:

```ts
for (let attempt = 0; attempt <= 12; attempt += 1) {
  expect(emailBackoffMs(attempt), `ladder diverged at attempt ${attempt}`)
    .toBe(reviewBackoffMs(attempt));
}
```

Confirmed to fail on demand — reintroducing `2 ** attempt` produces "ladder diverged at
attempt 1: expected 2000 to be 1000" in both the new test and the value test.

**The general rule:** when a comment says one module behaves "the same as" another, the
test should assert the equality between the two functions, not a list of literals copied
from whichever one was read first. A duplicated constant is a duplicated opportunity to
drift; a cross-module equality assertion fails the moment they part company.

**Evidence (local, PostgreSQL 16.2 + pgvector 0.6.2 + pg_trgm 1.6), after review round 2:**
```text
$ npm run db:migrate   # 28 applied from an EMPTY database (0028 lands)
$ npm run db:test      # 38 files / 400 passed (email outbox: 32)
$ npm test             # 47 files / 622 passed (email pure: 46)
$ npx tsc --noEmit && npx tsc --noEmit -p web/tsconfig.json && npm run lint   # clean
$ npm run web:build    # green; /gaps and /inbox/[conversationId] in the manifest
```
0028 verified by catalog inspection after a from-empty apply: `claim_outbox` owned by `concierge_worker`, `prosecdef = true`, ACL exactly `concierge_worker=X|concierge_app=X` (no PUBLIC entry — an entry with an *empty* grantee, which is what `=X/` inside a named entry is not), `claim_review_outbox` gone, `concierge_worker` NOLOGIN, and `pg_has_role('concierge_app','concierge_worker','MEMBER')` false.

**OUTSTANDING — real delivery evidence (§7).** DEC-4 closed on the provider and explicitly deferred credentials: the operator supplies `EMAIL_API_KEY` later, so **no real email has been sent and none was attempted**. Everything up to the send is tested; the one HTTP call is exercised against an injected `fetch` (endpoint, bearer header, body shape, 2xx/4xx/5xx/429/timeout/unreachable, non-JSON success) rather than against a live account. To close §7: set `EMAIL_FROM`, `EMAIL_API_KEY`, `EMAIL_ESCALATION_FALLBACK` and `CONSOLE_BASE_URL` in a staging `.env`, verify the sender domain in Resend, open a request as a guest, and keep the received email plus the `notification.sent` audit row with its `providerId`. This joins the other outstanding physical-evidence items (S07-01 QR scan, S08-01 stopwatch, S08-02 sources screenshot, S06-01 staging).

**Not done, by charter — and this bounds what the AC can claim.** Nothing schedules
`processEmailOutbox`, so as merged this item *queues* notifications and does not
*deliver* them: the end-to-end reading of "a request reaches a human by email" is not
operational until S11-01 deploys and schedules the worker. The AC is met at the level
this item owns — the row is written atomically with the request, survives provider
failure, resolves recipients correctly, and is composed and handed to a provider
correctly — and the delivery half is owed along with the credentials. Recorded here so
the gap is not discovered by someone waiting for an email that was queued and never
sent.

**Not done, by charter:** nothing schedules `processEmailOutbox` — S11-01 owns worker lifecycle for both outboxes (interval, shutdown, concurrency, the `sending` reaper), and this loop never writes `sending` so it cannot strand a row. Also out: a Resend webhook to reconcile provider-side bounces and complaints against rows we marked `sent` (we record that the provider *accepted* the message, not that a human read it); per-property fallback addresses (the current one is deployment-wide, which is why it is redacted); any non-email channel — `ESCALATION_CHANNELS` includes `in_app`, and `outbox.kind` has allowed `sms` since 0001, but neither has a sender; jitter and worker metrics.
