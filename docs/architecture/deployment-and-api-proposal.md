# Deployment and API architecture proposal

**Status:** Proposal for owner review — not an implementation decision  
**Last reviewed:** 2026-10-29  
**Scope:** Vercel deployment model, API boundary, environment/secret ownership, and migration sequence.

This proposal replaces trial-and-error deployment changes with an explicit target and staged migration. It does not claim that the provider-side configuration has been inspected or changed.

## Executive recommendation

1. **Use Vercel Git integration for both existing Vercel projects.** Let Vercel build the API and web projects using their configured roots/frameworks/build commands. Remove CI-driven Vercel CLI deployment and alias reassignment once native deployments are verified.
2. **Use CI for code quality and release gates, not as a second deployment system.** Required GitHub checks validate the commit. Vercel deployment checks must be configured to wait for those checks before promoting/serving production. Verify this with a test PR and controlled production test; do not assume a green GitHub check blocks Vercel by default.
3. **Treat the two Vercel projects as separate applications and deployments.** Keep a stable API origin and a stable web origin. The web server-side proxy can forward to the API origin; browser code should not receive API credentials.
4. **Redesign the API boundary before scaling its hosting surface.** The current business capabilities exist, but the deployed `api/` directory does not expose the whole application. First create an API inventory and contract, then choose Vercel Functions or a long-running service based on execution/worker requirements. Do not port every route mechanically before this choice.
5. **Do not give arbitrary PR previews production or staging credentials.** Production secrets belong to Vercel Production. Preview secrets must be considered accessible to preview deployments. If the Vercel plan/configuration supports a separately scoped staging environment, use it for a protected staging deployment; otherwise keep previews isolated and do not put sensitive staging credentials into the shared Preview scope.

## Current state found in the repository

### Deployment

- There are two Vercel projects. The repository has Vercel project identifiers referenced in docs and `VERCEL_WEB_PROJECT_ID` support in its configuration contract. Provider configuration was not inspected in this review.
- `.github/workflows/ci.yml` builds `.vercel/output` and deploys a PR preview through the Vercel CLI using a repo token. Its probe checks only `/api/health.ts`.
- `.github/workflows/deploy.yml` deploys API from CI: pushes to `main` go to a staging target; `v*` tags or a confirmed manual dispatch go to production. Web deployment remains gated behind manual `deploy-web` input.
- The deploy workflow pins custom domains with the Vercel aliases API. Issue [#162](https://github.com/jtanori/ai-guest-concierge-1/issues/162) records that production deployments can steal the staging alias under current domain configuration.
- `vercel.json` contains custom function routing. `.vercelignore` contains historic upload protections and local tooling exclusions. These should be reviewed against the native Git build before changing or removing them.
- CI and Vercel are separate gates. A passing GitHub workflow does not, by itself, prove that a native Vercel deployment waited for the required checks. That must be configured and demonstrated.

### API and web code

- `src/server.ts` is a Node HTTP server and route composition point. It wires health endpoints, guest routes, and staff route groups to service modules.
- Domain/service code is already spread across modules such as `src/guest`, `src/staff`, `src/knowledge`, `src/inbox`, `src/requests`, and `src/analytics`; the repository is not simply one file containing all business logic.
- The deployed Vercel API entry points are currently `api/health.ts`, `api/healthz.ts`, `api/healthz/postgres.ts`, and `api/review/[...path].ts`. The review adapter delegates to `src/staff/http.ts`.
- `src/staff/http.ts` defines review, inbox, settings, gaps, and analytics route handlers, but the Vercel API directory does not currently show corresponding deploy entry points for every group. Guest HTTP handlers are in `src/guest/http.ts` and are composed in `src/server.ts`.
- `web/` is a separate Next.js app with its own package and lockfile. Its API proxy routes forward chat and review calls server-side to `REVIEW_API_URL`.
- Issue [#153](https://github.com/jtanori/ai-guest-concierge-1/issues/153) directly records the missing deployed API surface, the web/API origin dependency, and the outstanding host decision. Issue [#159](https://github.com/jtanori/ai-guest-concierge-1/issues/159) covers web Vercel deployment. This is known backlog, not a missing API implementation.

## Proposed deployment model

### Projects and roots

| Vercel project | Root | Framework/build | Stable origin | Owns |
|---|---|---|---|---|
| API | API application root (to be established as part of API boundary work) | Explicitly configured Node/TypeScript build and function or service adapter | `api.<domain>` | Public/staff API, auth enforcement, database access, health/readiness |
| Web | `web/` or a deliberate workspace root | Next.js auto-detection/build | `app.<domain>` (or existing web domain) | Guest/staff UI and server-side proxy only |

Avoid relying on root auto-detection when a repository contains multiple apps. Configure each project root and build/install behavior explicitly, then test the configuration through Vercel Git deployment. Do not retain CLI `--prebuilt` deployment just to preserve an old build workaround unless native project builds demonstrably cannot produce the required output.

### Branch and environment behavior

The requested simple model is **production deploys from `main`; PRs create previews**. That is a good default. “Preview is staging” needs careful definition:

- Vercel preview deployments are typically per-commit/PR and use Preview environment variables; they are not automatically a single durable staging deployment.
- A permanent staging site can be a protected `staging` branch deployment assigned to a stable staging domain, or a separately scoped Vercel environment if the account/plan and project configuration support it.
- Do not alias a production domain to arbitrary deployments in a CI script. Prefer Vercel's Git branch/domain association for a stable staging branch, or a documented Vercel environment/domain binding.
- If the owner wants exactly `main → production` and `staging → stable staging`, use those two branches intentionally. Require changes to flow through PRs and define how `staging` is promoted to `main`; do not add a staging branch without agreeing to that lifecycle.

PR previews must not silently inherit sensitive staging data. If previews need backend functionality, use a deliberately isolated preview backend/database with limited credentials, or make preview-only functionality degrade safely. Never expose production credentials to untrusted PR code.

### CI and deployment gates

**GitHub CI (required before merge):**

- lint, typecheck, unit tests, DB tests, and API/web builds;
- contract/schema compatibility tests and API route integration tests;
- no production credentials in PR CI;
- Vercel Git deployment checks configured so production does not receive a commit until required checks pass.

**Vercel (build and deploy):**

- build from the selected commit using the project root and normal framework/build settings;
- PR preview: deploy both projects, then run integration/smoke checks against the preview URLs (using non-production data/credentials);
- staging branch: deploy both projects, run migrations through a controlled migration job or documented release command, then probe API and web and their connection;
- production: deploy the tested commit, apply backwards-compatible migrations under the agreed release policy, verify health and core routes, and report the exact commit/deployment IDs.

Do not let a missing URL turn a smoke test into a successful skip for a release. If a deployment tier is in scope, its URL and smoke test are required. Keep checks focused on observable product behavior, not on aliases.

### Secrets and environment ownership

- **Runtime secrets** (database, LLM/provider, cookie signing, auth) should be stored in the runtime host's scoped environment and injected only into the application/job that needs them.
- **Web public build variables** (for example, Turnstile site key) are public by design; set them on the web project. They are not API secrets.
- **Web server-only configuration** (API origin and any server-side credentials) stays server-side and is set on the web project as appropriate.
- **Migration credentials** belong to a protected migration job or operator process with least privilege. They should not require duplicating every app secret into GitHub merely because CI currently performs deployment.
- **Vercel Git integration** should remove the need for `VERCEL_TOKEN` in ordinary build/deploy jobs. Retain a token only if a narrowly scoped automation demonstrably requires it.
- Keep local `.env` files out of Git and deployments. Review `.vercelignore` and confirm Vercel's configured environment settings; do not upload local secret files.
- Decide explicitly whether staging and Preview share credentials. If they do, treat all code deployed to Preview as trusted to access those resources. The safer default is not to share.

## API architecture target

A separate API does not require a separate repository. Keep a monorepo if useful, but make application boundaries visible and independently testable. A possible target layout is:

```text
apps/
  api/                    HTTP application, routing, auth adapters, API schemas
  web/                    Next.js UI and same-origin server-side proxy
packages/
  contracts/              OpenAPI document, generated/validated client types
  domain/                 domain services only where sharing is justified
  database/               DB client, migrations, tenant-scoped repositories
```

This is illustrative; migration should follow boundaries actually present in the code, not rename folders for appearance.

The API should have:

- a versioned, documented HTTP contract (OpenAPI is the recommended source of truth);
- explicit route ownership and method/content-type/status behavior;
- consistent validation, error envelope, pagination, and request/correlation IDs;
- authentication and tenant authorization enforced in the API, never delegated to the web proxy;
- contract tests plus integration tests for guest and staff route groups;
- a generated or type-safe web client where it reduces drift;
- health/readiness endpoints that distinguish process liveness from dependency readiness;
- explicit timeouts/rate limits/body limits and an error-handling policy;
- an execution model suitable for chat/provider calls and the future worker/outbox lifecycle.

### Hosting decision gate

Keep the API on Vercel only if the full API can be delivered safely within the function model: request duration, streaming/response behavior, connection pooling, background work, and operational observability must all fit. Do not move background workers into request functions by assumption.

If requirements need a persistent process, long jobs, or independently managed worker lifecycle, run `apps/api` as a long-running service and keep the web project on Vercel. The HTTP API contract remains the same either way. This is a focused runtime choice, not a reason to couple web and API into one deployment.

## Migration plan

### Phase 0 — decisions and baseline (no behavior changes)

- Confirm branch policy: `main` is production; decide whether a protected `staging` branch is wanted or whether staging uses a separately scoped Vercel environment.
- Confirm whether PR previews may use any non-production backend. Default: no staging/prod database or provider secrets in arbitrary previews.
- Export/document current Vercel project roots, framework/build settings, Git connection, domains, environment-variable scopes, and production branch. Verify these in the Vercel dashboard; repository files cannot prove them.
- Record current domains and which project serves each; identify and remove reliance on alias-after-deploy only after native binding is tested.
- Inventory API routes and callers, then establish baseline route tests and deployment observations.

### Phase 1 — native Vercel deployment proof

- Connect both Vercel projects to the repository through Git integration.
- Configure explicit roots and framework/build commands for API and web.
- Configure `main` production behavior and PR previews; test a PR deployment for both projects.
- Configure branch/environment/domain handling for stable staging without an alias-pinning script.
- Set CI deployment gates and verify with a deliberately failing required check that production is not updated.
- Keep the current deploy workflow available as a rollback during this proof; do not run competing automation against the same production project.

### Phase 2 — API contract and boundary

- Inventory every route in `src/server.ts`, `src/guest/http.ts`, `src/staff/http.ts`, and `api/`; mark implemented, exposed, tested, and called by web.
- Create OpenAPI/API contract for the actual behavior; do not invent route semantics while extracting.
- Separate transport/composition from domain services incrementally. Add Vercel adapters for supported routes only if Vercel remains the chosen runtime.
- Add cross-origin/server-side proxy integration tests and tests that ensure auth, tenant context, cookies, and errors survive the proxy boundary.
- Run the full route suite against the deployed API before directing web staging traffic to it.

### Phase 3 — simplify and retire legacy automation

- Move schema migration to a controlled, protected release step with documented expand/contract practices.
- Remove routine Vercel CLI deploys, manual alias pinning, redundant Vercel credentials, and obsolete secret-sync destinations only after native deployments are proven.
- Make staging and production smoke suites required and non-skippable for the tiers being released.
- Update `docs/environments.md`, `docs/env-setup.md`, and `docs/runbook.md` to match the final dashboard configuration and release process.
- Close or revise #153, #159, #160, and #162 so their acceptance criteria reflect the chosen design rather than the current workaround.

## Acceptance criteria for the new strategy

- A PR produces API and web previews from the same commit, with no production credentials available to PR code.
- Required CI checks are demonstrably enforced before production deployment.
- A documented, repeatable staging deployment serves both tiers from stable origins without a script pinning aliases.
- The full API route inventory has a published contract; every route used by web is reachable in the selected hosting model and covered by integration tests.
- A production release identifies the tested commit, applies migrations under the agreed policy, deploys both tiers, and cannot report verified success if either tier's smoke test did not run and pass.
- Routine deploys do not need a Vercel CLI token stored in GitHub Actions.

## Detailed implementation plan and calculated changes

### Working assumptions for the estimate

This estimate is for one experienced engineer familiar with the repository, with an owner available for Vercel dashboard access, credentials, and decisions. It excludes waiting on DNS propagation, paid-plan upgrades, vendor support, and code review latency. The estimates are deliberately ranges because Vercel team settings and the production runtime constraints have not been inspected.

**Recommended initial scope:** preserve the existing two Vercel projects and current domain names; production branch `main`; PR previews; a dedicated protected staging branch/domain; no production credentials in previews; keep API on Vercel only if the function-runtime spike passes. If the API spike fails, add a separately-estimated service-host deployment rather than forcing the code into functions.

### Work breakdown and effort

| ID | Work package | Calculated changes / outputs | Estimate |
|---|---|---|---:|
| P0 | Confirm release/security decisions + inspect provider state | Decision record; export both Vercel project settings; record domains, roots, framework, Git connection, environment scopes, branch bindings, current deployment IDs; record rollback procedure | 0.5–1.0 d |
| P1 | API inventory + execution-model spike | Route matrix below; map web callers; measure/inspect chat and provider timeout chain, DB pool behavior, worker lifecycle; deploy a minimal API function proof using real API dependencies to a non-production preview; decide Functions vs persistent service | 1.0–1.5 d |
| P2 | API contract baseline | Add `openapi.yaml` (or equivalent generated source), stable error schema, health/readiness definitions, document existing behavior without breaking it; add route coverage check that flags implementation/deployment drift | 1.5–2.5 d |
| P3 | API boundary extraction/adapters | Introduce `apps/api` composition/transport boundary while preserving `src` domain modules; API entry adapters for every supported route group; retain `src/server.ts` as local/long-running adapter during transition; no domain rewrite | 2.0–4.0 d |
| P4 | Contract and integration tests | OpenAPI validation; handler contract tests; real HTTP integration tests for all exposed route groups; web proxy tests for cookies/auth/context/status/errors; Vercel preview smoke covering critical API and web paths | 1.5–2.5 d |
| P5 | Native Vercel Git integration proof | Connect/configure both projects; explicit project roots/builds; branch and environment config; verify PR previews and staging branch deploys; establish GitHub check gate; remove duplicate deploy path only after comparison | 1.0–2.0 d |
| P6 | Migration/release automation + runbook | Protected migration step, expand/contract policy, smoke requirements, rollback docs, update env setup/runbook and close/re-scope #153/#159/#160/#162 | 1.0–1.5 d |
| P7 | Production cutover and observation | Controlled release of same tested SHA, verify both stable origins/routes and migration outcome; monitor and retain old deployment/host for rollback window | 0.5–1.0 d |

**Subtotal if API stays on Vercel:** 9.0–16.0 engineer-days.  
**Planning target:** 11–12 days assuming the route handlers are already function-compatible and Vercel project settings are accessible.  
**If a long-running API service is required:** add approximately 2–4 engineer-days for containerization/host config, health/shutdown behavior, deployment/secret wiring, and rollback; cloud account provisioning and vendor approval are not included.

This is an implementation estimate, not an attempt to re-estimate the product backlog. Phase P1 is a short decision gate specifically intended to prevent spending P3/P5 effort on the wrong runtime.

### API route inventory (first contract scope)

The inventory below is a baseline from the route tables in `src/guest/http.ts`, `src/staff/http.ts`, `src/server.ts`, and current Vercel entry points. Before writing OpenAPI, enumerate the regex route definitions to capture exact subpaths, payload schemas, and response schemas; the table is grouped by handler and is not an exhaustive OpenAPI listing.

| Surface | Existing handler | Current Vercel entry point(s) | Known web/API use | Initial action |
|---|---|---|---|---|
| Health / readiness | `src/server.ts` health table | `api/health.ts`, `api/healthz.ts`, `api/healthz/postgres.ts` | deploy smoke/ops | Define liveness vs readiness; consolidate semantics without breaking existing probes |
| Guest property | `GET /api/chat/property` | No guest adapter listed | web property route/proxy | Expose and contract-test |
| Guest QR | `GET /api/chat/qr.svg` | No guest adapter listed | web QR route proxies API | Expose binary/SVG response correctly; test content type/cache |
| Guest transcript/messages | `GET/POST /api/chat/messages` | No guest adapter listed | web chat proxy | Expose; test signed cookie round-trip and provider timeout budget |
| Guest handoff | `POST /api/chat/handoff` | No guest adapter listed | web chat proxy | Expose; preserve no-provider-call behavior |
| Review | `GET /api/review/queue`, `GET /api/review/contradictions`, `POST /api/review/versions/{id}/approve|reject`, `POST /api/review/contradictions/resolve` | `api/review/[...path].ts` | web review proxy | Verify deployed adapter forwards all paths/methods and complete auth/config |
| Inbox | `GET /api/inbox`, conversation detail/action routes, answer flag, request actions | No dedicated Vercel adapter listed | staff web/API | Expose all exact handler routes; preserve role + tenant tests |
| Settings | AI mode GET/POST | No dedicated Vercel adapter listed | staff web/API | Expose and contract-test |
| Gaps | list/close | No dedicated Vercel adapter listed | staff web/API | Expose and contract-test |
| Analytics | dashboard GET | No dedicated Vercel adapter listed | staff web/API | Expose and contract-test |

Route discovery is an explicit P1/P2 deliverable: generate the final operation list from the source route tables and web call sites, then require one-to-one coverage among implementation, OpenAPI, tests, and deployed adapter. Never infer missing endpoints from the route-family names alone.

### Calculated repository changes

These are expected changes, not a commitment to move every module or rename the whole repository.

| File/folder | Planned change |
|---|---|
| `src/guest/http.ts`, `src/staff/http.ts` | Preserve domain-facing handlers initially; add/adjust transport-neutral contracts only where adapters currently depend on Node request/response types. No broad rewrite in the first pass. |
| `src/server.ts` | Keep as local/long-running adapter during migration; move dependency composition behind an injectable application factory so production adapters and integration tests construct the same app. |
| `api/**` | Replace the current partial surface with explicit function adapters for the full supported API route set if P1 confirms Vercel compatibility. Avoid a catch-all that bypasses route-specific limits or hides missing route coverage. |
| `apps/api/**` (conditional) | New API composition root, runtime entry points, and API build configuration. Create only after deciding runtime; if Vercel root constraints make this awkward, keep root `api/` as adapters while placing shared application code under `src/`. |
| `web/app/api/**`, `web/lib/api-base.ts` | Preserve same-origin server-side proxy; add tests and ensure all required methods, cookies, auth and headers are intentionally forwarded. Establish per-deployment API origin settings. |
| `openapi.yaml` or `packages/contracts/**` | Document actual route behavior, schemas, errors, security, pagination, and health endpoints; add format/lint/compatibility CI. |
| `vercel.json`, `.vercelignore` | Revisit after native Git builds; simplify only after clean deploys of each project. Preserve `.env*` exclusions and verify function routing/build semantics. |
| `.github/workflows/ci.yml` | Keep checks; add API contract and integration gates. Remove CLI preview deployment only after native previews are proven and branch-protection checks are correct. |
| `.github/workflows/deploy.yml` | Retire manual deploy/alias logic after native production/staging behavior and migration ownership are verified. Retain a manual migration/recovery workflow only if needed. |
| `src/config/manifest.ts`, `scripts/secrets-sync.ts`, `scripts/check-secrets.ts` | Simplify store targets around actual runtime ownership; avoid syncing every runtime key to GitHub and Vercel redundantly. Preserve local readiness validation and secret redaction. |
| `docs/environments.md`, `docs/env-setup.md`, `docs/runbook.md`, `docs/phase-b-handover.md` | Replace stale descriptions of CLI deploys, shared Preview secrets, aliases, and host gaps with verified dashboard configuration and release instructions. |
| `tests/**` | Add API contract/adapter coverage, route deployment coverage, proxy integration coverage, plus configuration guard tests for root/branch/env assumptions where testable in-repo. |

### Integration sequence with explicit gates

#### Gate A — owner/provider decisions (before implementation)

Choose defaults unless the owner says otherwise:

- `main` is the production branch.
- A protected `staging` branch is the durable staging deployment; PRs remain ephemeral previews.
- PR previews have no production or staging DB/provider secrets. They use either an isolated preview backend or documented UI-only/degraded mode.
- Current web and API domains remain unless there is a naming reason to change them.
- Vercel Functions remain the API target only if the P1 spike passes; otherwise the API runtime is a separate service.

Evidence to collect: screenshots/export or notes of Vercel project roots, Git integration, domains, branch associations, env scopes, and the exact current production deployment SHA. Do not include secret values in the artifact.

#### Gate B — runtime feasibility (P1)

Run one bounded proof using the actual guest and staff dependency graph, not the health-only function:

- initialize database pool safely for the function lifecycle;
- exercise one guest API request and one authenticated staff request in a non-production environment;
- observe connection reuse/cleanup, request duration under configured provider timeouts, body/cookie handling, error behavior, and logs;
- explicitly verify no worker/outbox work is assumed to survive the request lifecycle.

**Pass:** both representative paths work within documented function limits with safe DB behavior and observability. Proceed with Vercel function adapters.  
**Fail/uncertain:** stop the Vercel API port; deploy the API composition as a long-running service instead. Keep the same contract and web proxy.

#### Gate C — contract before broad adapter work

- Check in the route matrix and OpenAPI document based on current tested behavior.
- Validate the spec and add a test that every declared operation maps to a handler and every handler route is declared or explicitly internal.
- Record intentional differences between internal route paths and public paths, if any.
- Freeze breaking behavior changes out of this infrastructure effort; versioning/redesign of semantics is a separate approved scope.

#### Gate D — shadow deployment, no traffic cutover

- Connect projects and enable Git deployments without changing stable production domains initially.
- Run preview deployments from a test PR; ensure API and web build from the intended roots and same commit.
- Use isolated preview credentials only; test web-to-API proxy with safe fixture data.
- Verify failed GitHub required checks prevent promotion to production. If native Vercel integration cannot enforce the desired gate, keep a narrow promotion gate (not a parallel build/deploy system) until it can.
- Compare native deployment behavior to existing CI deployment on a harmless preview, then disable the duplicate preview deploy to avoid duplicate/competing deployments.

#### Gate E — stable staging

- Deploy the same tested commit to the protected staging branch/environment.
- Assign the stable staging domain through Vercel's supported branch/domain/environment binding, not an after-deploy alias script.
- Run DB migrations through the selected controlled migration mechanism; test migration success/failure behavior before production.
- Require API health/readiness + guest route + authenticated staff route + web page + web-to-API integration probes. Missing endpoint/config is a failed verification, not a skip.
- Confirm a production deployment does not change staging's target/domain.

#### Gate F — production cutover

- Establish expand/contract migration rules; deploy backward-compatible schema changes before code that requires them.
- Release the exact SHA that passed CI and staging, with owner approval and database backup/restore plan appropriate to the migration.
- Require both API and web production checks, and record Vercel deployment IDs and commit SHA.
- Keep the prior working deployment available for rollback. Rollback application code independently from database rollback; use forward-fix for irreversible migrations.
- Remove `VERCEL_TOKEN`/CLI deploy workflows and alias workarounds only once the native path has succeeded through at least one staging release and one production release.

### Test matrix to add

| Layer | Required cases |
|---|---|
| OpenAPI | Syntax/lint; request and response schemas; auth declarations; no undocumented handler routes; compatibility check for accidental breaking changes |
| API route adapters | Each route group reaches the shared handler; supported methods, 404/405, body limits, content types, query strings and headers preserved |
| Security | Guest cookie set/read across web proxy; staff bearer token remains server-side; tenant headers cannot be trusted from arbitrary browser input; role denial and cross-tenant tests remain green |
| Runtime | Strict readiness fails on missing required config; liveness does not imply dependency readiness; DB pool behavior and provider timeouts within runtime budget |
| Web proxy | API origin configurable per environment; timeout/502 behavior; cookies and `Set-Cookie`; no token in browser output/logs; no open proxy/host-header destination control |
| Deployment | Both apps preview the same SHA; failed required check blocks production; branch/domain mapping stable; missing smoke target fails; staging remains staging after production release |
| Database release | Migration applies from empty/current schema; repeated deploy is safe; backward-compatible rollout; failure stops promotion and documents recovery |

### Ownership and sequencing

Suggested implementation sequence: P0 and P1 as the immediate kickoff; P2 can proceed in parallel after the route inventory is agreed; P3 depends on Gate B; P4 follows the API adapter contract; P5 can run in parallel with P2/P4 but must not cut over production; P6 follows successful staging; P7 is owner-approved.

**Critical path:** owner decisions → P1 runtime decision → API contract/boundary → integration tests → staging native-deploy proof → production cutover.  
**Parallelizable:** provider-settings inventory and route/caller inventory; contract formatting/tests after initial route list; web-proxy tests while API adapters are implemented.

### Definition of done

- Two Vercel project configurations are documented and match the repository roots/builds.
- Vercel Git creates expected PR previews and staging/production deployments with an enforced CI gate; routine deploy uses no GitHub-held Vercel token.
- No alias-pinning step is required; stable domain binding is verified across staging and production deploys.
- The API route inventory and OpenAPI document agree with handler and deployed coverage.
- Guest and authenticated staff routes plus web proxy pass integration tests against the chosen runtime.
- Preview credential boundaries are demonstrated, not just documented.
- Migration, smoke, rollback, and operator procedures are rehearsed and documented.
- Obsolete automation and misleading runbook statements are removed only after cutover evidence exists.

## Canary assertion and resolution (S06A)

The owner-reported run #40837948865 (after PR #163) is recorded in `docs/runbook.md` as 0/20 false answers (sample unarmed), 7/7 correct escalations, 12/20 correct-or-escalated (60%), and 8/13 needless escalations (61.5%). A separate retrieval-only probe reports 11/13 target-topic recall (84.6%). G2 is not passing: two applicable quality thresholds fail, and the false-answer cap cannot be called passed below the 50-row minimum.

Static inspection confirms the harness diagnostic conflates the empty topic list on non-answer outcomes with retrieval evidence: `observedFrom()` records no topics for `escalate`/`no_answer`, and the retrieval diagnostic uses those topics. The report must distinguish retrieval not run from retrieval run/empty. Static inspection also confirms the evaluator passes neither a structured intent nor a topic classification into `answerMessage`; it deliberately does not use golden labels as runtime inputs. The exact causal distribution among the eight misses remains to be reproduced with stage-level traces.

Resolution order and acceptance are tracked in approved epic [#166](https://github.com/jtanori/ai-guest-concierge-1/issues/166) and its seven stories #167–#173: correct eval provenance; calibrate deterministic safety/booking rules; wire conservative intent-to-fact routing; measure/fix bilingual retrieval; define the API contract and runtime; prove native Vercel Git deploys; then expand the reviewed golden set to ≥50 and arm the absolute gate. Preserve historical baselines and safety tests throughout.

## Decisions still requiring owner confirmation

The proposal includes recommended defaults above so work can start quickly. Please confirm or change these four decisions:

1. **Branch policy:** accept `main → production`, protected `staging → staging`, PR → ephemeral preview?
2. **Preview data/secrets:** accept no staging/prod credentials in PR previews; use isolated preview data or UI-only preview?
3. **API runtime:** authorize the 1–1.5 day feasibility spike, then choose Vercel Functions only on a pass; otherwise a separate service?
4. **Domains:** retain the current `bretu.dev` API/web hostnames for the first cutover?
