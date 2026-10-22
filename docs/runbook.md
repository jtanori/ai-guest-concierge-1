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


## W00-11 — Repo, branch protection, org setup (0.50d)

**AC (verbatim):** A direct push to main is rejected.

**Status: NOT DONE — local half complete, remote half pending (Phase B).**

- [x] Local: `git init -b main` in project root (was not a repo).
- [x] Local: `.gitignore` — rejects `.env*` (except `.env.example`), node_modules, dist, coverage.
- [x] Local: PR template `.github/pull_request_template.md` — item ID + verbatim AC + evidence checklist + isolation/i18n notes.
- [x] Local: `.editorconfig` (LF, utf-8, 2-space), `.gitattributes` (LF)
- [x] Local: project scaffold — package.json, tsconfig (strict), eslint flat config.
- [x] Local: `scripts/protect-main.sh` — the exact `gh` call that applies branch protection once the remote exists.
- [ ] **YOU (Phase B):** create the `ai-guest-concierge` repo on GitHub, add the remote:
  ```powershell
  git remote add origin git@github.com:<ORG>/ai-guest-concierge.git
  git push -u origin main
  ```
  then run `ORG=<org> REPO=ai-guest-concierge ./scripts/protect-main.sh` (needs Git Bash or WSL; requires `gh` authenticated as admin).
- [ ] **Evidence (AC test):** `git push origin main` from a working tree with no open PR → refused with `GH006` / `remote: error: gh006: Protected branch update failed`.

**Notes.** No CI contexts are attached until W00-12's workflow exists (the script prints the follow-up command). Admins are bound (`enforce_admins: true`) so the rule applies to the founder too.

**Evidence (local half, verified):**
```text
$ git log --oneline
bd14424 W00-11: repo governance — gitignore, PR template, branch-protection script, editorconfig, runbook start
6f17696 W00-11/12: project scaffold — npm toolchain, TS config, eslint, ES/EN string catalogue (D14)
```

## W00-12 — CI skeleton: lint, typecheck, test, preview (0.75d)

**AC (verbatim):** A PR produces a preview URL and a green check.

**Status: NOT DONE — remote half pending (Phase B). Local equivalents verified green.**

- [x] Toolchain: TypeScript 5 (strict, NodeNext), vitest 3, eslint 9 (flat config), prettier 3 — npm scripts `lint`, `typecheck`, `test` under Node 24.
- [x] First module ships with its tests and obeys D14: `src/i18n/catalog.ts` — ES/EN string catalogue, key parity enforced by type + runtime test.
- [x] CI workflow `.github/workflows/ci.yml`: three required contexts (`lint`, `typecheck`, `test`) on every PR; `preview` job stubbed and explicitly marked as a Phase B step.
- [x] Local evidence (below): lint + typecheck + test all green.
- [ ] **YOU (Phase B):** push to GitHub (Actions work when the repo exists); open one throwaway PR → `lint`/`typecheck`/`test` green check.
- [ ] **YOU (Phase B):** create a Vercel account, connect the repo, then replace the `preview` stub in `ci.yml` with the Vercel deploy action so the job returns a real preview URL.
- [ ] **Evidence (AC test):** the throwaway PR shows a green check AND a reachable preview URL. Only then mark Done in the workbook.

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
