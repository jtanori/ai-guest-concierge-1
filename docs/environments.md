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

## Where each value must live — one name, one environment

| Store | Holds | Read by |
|---|---|---|
| GitHub Environment **`staging`** — secrets | `DATABASE_URL`, `LLM_API_KEY`, `EMAIL_API_KEY`, `GUEST_COOKIE_SECRET`, … | the staging deploy job |
| GitHub Environment **`staging`** — variables | model ids, public URLs, `API_URL` | the same job |
| GitHub Environment **`production`** — the same names | production values | the production deploy job |
| GitHub **repo** secrets/variables | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | both jobs — one Vercel project serves every environment |
| Vercel env **preview** | `REVIEW_API_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (staging values) | the Next.js tier |
| Vercel env **production** | the same keys, production values | the Next.js tier |

**There is no `PROD_LLM_API_KEY`.** The name is `LLM_API_KEY` in both environments,
and a job's `environment: production` is the only thing that makes it resolve to
production's value. Suffixed names double the contract: every new variable would need
two entries, and the workflow would need to remember which suffix belongs to which
job. The manifest enforces the rule by having exactly one entry per variable.

Staging deploys to Vercel's **preview** target and prod to **production**; that
mapping is `vercelTargetFor()` and it is asserted by a test, because getting it
backwards puts staging's console URL in production's emails.

The rule is enforced, not just documented: `src/config/deploy-workflow.test.ts` reads
`deploy.yml` and fails if it names a variable after its environment, trusts a value as a
secret that the manifest calls public (or the reverse), gives the two jobs different
sets of names, deploys before migrating, or echoes a secret into a log.

## `secrets:sync` — one file, every store

```bash
npm run secrets:sync -- --env-file=.env.staging --env=staging            # write
npm run secrets:sync -- --env-file=.env.staging --env=staging --dry-run  # plan only
npm run secrets:sync -- --env-file=.env.production --env=prod --force    # rotate secrets
```

It reads one file, and **where each value goes is decided by the manifest, not by the
script** — there is no second opinion to drift.

| Action | Meaning |
|---|---|
| `+ create` | absent remotely, will be written |
| `~ update` | present with a different value (variables), or `--force` (secrets) |
| `=` | variables only: compared and identical |
| `· skip-present` | **present, not compared** — see below |
| `? blocked` | the store could not be read; nothing was decided |
| ` ` runtime | the host injects it; not a sync target |

### Why secrets say "present, unverified" and not "unchanged"

A GitHub Actions secret is **write-only**. The API returns names and `updated_at`,
never a value — by design. So a secret that already exists is skipped and reported as
`skip-present`, which is a different claim from `skip-equal`. Variables *are* compared
by value; secrets can only be observed.

The practical consequence: **rotating a key upstream and re-running sync will not push
it unless you pass `--force`.** That is the price of write-only storage, and it is
cheaper than the alternative — a script that rewrites forty secrets every run and burns
the only history GitHub keeps.

Vercel returns values for plain variables and omits sensitive ones; the same rule
applies per variable.

### What it refuses to do

- Push `.env.staging` into the `production` environment: if the file's `APP_ENV` does
  not match `--env`, it exits 2 without writing anything.
- Invent a value for a required variable that is missing from the file — those are
  listed as `absent` instead.
- Print, log, or serialise a secret value. `--json` emits names and actions only.

`--only=LLM_API_KEY,EMAIL_API_KEY` narrows a run; `--no-github` / `--no-vercel`
restrict destinations.

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

## Seeding a new environment

```bash
# 1. write the file from the contract, then check it is complete
cp .env.example .env.staging
npm run check:readiness -- --env staging --file .env.staging

# 2. place every value in the store the manifest assigns it to
npm run secrets:sync -- --env-file=.env.staging --env=staging --dry-run
npm run secrets:sync -- --env-file=.env.staging --env=staging

# 3. verify from the other side: ask the stores, not the file
npm run check:secrets -- --env staging
```

Prerequisites for step 2: `gh auth login` with admin on the repository (creating the
GitHub Environment needs it), and `VERCEL_TOKEN` + `VERCEL_PROJECT_ID` in the file or
the shell. Without them the affected rows are `blocked` — never silently skipped.

`secrets:sync` creates the GitHub Environment (`staging` / `production`) when it does
not exist. Protection rules — required reviewers on `production`, for instance — are
configured in Settings → Environments, not by this script: a script that can loosen its
own gate is not a gate.

## Things that are still not done

Stated here so nobody assumes otherwise:

- **No host for `src/server.ts`.** See above.
- **`SENTRY_DSN` is a contract entry but not enforced** — W00-14 has no reporter
  wired, so requiring it would fail a deploy over a feature that does not exist. It
  is marked `planned` in the manifest and excluded from the audit.
- **The API deploy is not gated by the smoke test yet**, because there is nothing to
  probe until a host exists.
