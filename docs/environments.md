# Environments — local, staging, production

W00-13. The contract is code (`src/config/manifest.ts`), the checks are scripts, and
this page is how you use them.

## The contract, in one sentence

Every variable declares **which environments require it**, whether it is a **secret**,
and **where it must live** for a deployed environment — and `staging`/`prod` refuse to
boot when anything required is missing.

## The three commands

| Command | Answers | Exit codes |
|---|---|---|
| `npm run check:env` | are staging and prod pointing at *different* databases? | 0 ok, 1 shared |
| `npm run check:readiness -- --env <env>` | is this environment *complete*? | 0 ready, 1 not ready, 2 could not run |
| `npm run check:secrets -- --env <env>` | is each value in the store the pipeline reads? | 0 complete, 1 gaps, 2 nothing verified |
| `npm run smoke -- --target <env>=<url>` | does the deployed thing answer, and is it the environment it claims? | 0 pass, 1 fail, 2 usage |

`2` is deliberately separate everywhere. A pipeline must be able to tell *"the
environment is broken"* from *"the check never ran"* — collapsing those two is how a
deploy reports green forever without ever having verified anything.

## Before you deploy

```bash
# 1. write the file (never commit it — .env* is gitignored except .env.example)
cp .env.example .env.staging

# 2. complete it, then ask whether it is enough
npm run check:readiness -- --env staging --file .env.staging

# 3. ask whether the values exist where the pipeline will look for them
npm run check:secrets -- --env staging --file .env.staging --inventory github,vercel

# 4. the matrix, with a local leg so reusing the dev database is caught too
LOCAL_DATABASE_URL=postgres://concierge:concierge@localhost:54329/concierge_local \
STAGING_DATABASE_URL=... PROD_DATABASE_URL=... npm run check:env
```

`check:readiness` prints **every** gap in one pass, not the first, and never prints a
secret value — secrets appear as `set`, and any secret a loader interpolates into its
own error message is scrubbed before the report is rendered.

## Fail-fast, and the one exception

| `APP_ENV` | boot when config is incomplete |
|---|---|
| `local` | tolerant — the surface answers 503 with the reason |
| `staging` | **refuses to start** (exit 1, names every gap) |
| `prod` | **refuses to start** |

A staging host that genuinely needs to run degraded — a Vercel preview with no
secrets — sets `ALLOW_DEGRADED_BOOT=1`. It logs `BOOTING DEGRADED` at warn level,
reports `boot: "tolerant"` on `/healthz`, and the smoke test fails it for not being
strict. **`prod` refuses the flag outright**, the same way it refuses `AI_FAIL_MODE`:
a production host that can skip its own configuration check by one variable is a host
where one copied file is an outage.

## Where each value must live

| Store | Holds | Read by |
|---|---|---|
| GitHub Actions secrets | database URLs, provider keys, cookie secret | `.github/workflows/deploy.yml` |
| GitHub Actions **variables** | non-secret config: model ids, public URLs, `*_API_URL` | the same workflow |
| Vercel env (**preview**) | staging's `REVIEW_API_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | the Next.js tier |
| Vercel env (**production**) | the same keys, production values | the Next.js tier |
| Platform process env | the runtime `DATABASE_URL` the host injects | the API process |

Staging deploys to Vercel's **preview** target and prod to **production**; that
mapping is `vercelTargetFor()` and it is asserted by a test, because getting it
backwards puts staging's console URL in production's emails.

## What the deploy workflow does, in order

`.github/workflows/deploy.yml` — staging on merge to `main`, production on a `v*` tag
or a manual run that types `deploy-production`:

1. **readiness** — refuse before touching anything
2. **check:env** — staging and prod are still different databases
3. **migrate** — schema first, against that environment's database
4. **deploy** — only now does new code meet an upgraded database
5. **smoke** — `/healthz`, `env` matches the target, boot is strict, Postgres answers,
   and (when both targets are given) the two clusters are provably different

Migrations run **before** deployment on purpose: the alternative is new code against
an old schema, which fails in the request path rather than in the pipeline.

### The smoke step can be skipped, and it says so

`STAGING_API_URL` / `PROD_API_URL` are GitHub **variables**. When they are absent the
smoke step prints a warning, writes "Smoke skipped" to the job summary, and does not
fail the build. That is a visible gap, never a pass.

### What this workflow does not deploy yet

The Vercel project in this repository is the API surface (`api/**`). The long-running
application process (`src/server.ts`) has **no host configured**, so staging and
production deploy the Vercel surface and migrate the database — they do not serve the
product. Choosing that host (Fly, Render, a container on ECS, a Neon Function) is an
infrastructure decision that belongs to you, not to a YAML file. Until it is made, no
environment should be described as "live".

## Proving the environments differ

`/healthz/postgres` reports `cluster`: the first 16 hex of `sha256(system_identifier)`.
It is stable per Postgres cluster, reveals nothing (the raw identifier is never
published, and the route is unauthenticated), and it is the only reliable way to
answer the AC's question on Neon — **every Neon branch names its database `neondb`**,
so comparing database names would fail a correct deployment and pass two databases on
one cluster. `smoke` compares fingerprints when you give it two targets:

```bash
npm run smoke -- \
  --target staging=https://api.staging.example.com \
  --target prod=https://api.example.com
```

## Secrets that must exist before the first real deploy

These are the ones the workflow reads; `check:secrets` tells you which are missing.

```text
GITHUB SECRETS                          GITHUB VARIABLES
STAGING_DATABASE_URL                    REVIEW_API_URL
PROD_DATABASE_URL                       LLM_PRIMARY_MODEL / LLM_FALLBACK_MODEL
GUEST_COOKIE_SECRET                     NEON_AUTH_ISSUER / NEON_AUTH_JWKS_URL
LLM_API_KEY                             GUEST_PUBLIC_URL
EMBEDDING_API_KEY                       EMAIL_FROM / EMAIL_ESCALATION_FALLBACK
TURNSTILE_SECRET                        CONSOLE_BASE_URL
EMAIL_API_KEY                           STAGING_API_URL / PROD_API_URL
NEXT_PUBLIC_TURNSTILE_SITE_KEY          (smoke target — optional, visibly skipped)
VERCEL_TOKEN / VERCEL_ORG_ID / VERCEL_PROJECT_ID

PRODUCTION OVERRIDES (never reuse staging's)
PROD_GUEST_COOKIE_SECRET, PROD_LLM_API_KEY, PROD_EMBEDDING_API_KEY,
PROD_TURNSTILE_SECRET, PROD_EMAIL_API_KEY
```

Production uses `PROD_`-prefixed keys for every provider credential. Reusing a
staging key in production means revoking it in staging breaks production — and means
a staging row and a production row are billed to the same account with no way to tell
them apart.

## Things that are still not done

Stated here so nobody assumes otherwise:

- **No host for `src/server.ts`.** See above.
- **`SENTRY_DSN` is a contract entry but not enforced** — W00-14 has no reporter
  wired, so requiring it would fail a deploy over a feature that does not exist. It
  is marked `planned` in the manifest and excluded from the audit.
- **The API deploy is not gated by the smoke test yet**, because there is nothing to
  probe until a host exists.
