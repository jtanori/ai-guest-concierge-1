# Getting every value in `.env`

Companion to `.env.example`. That file is the checklist; this page is where each
value comes from, what shape it must be in, and what breaks when it is wrong.

Three files, one variable name each:

| File | `APP_ENV` | Used by |
|---|---|---|
| `.env` | `local` | your machine |
| `.env.staging` | `staging` | the staging deploy |
| `.env.production` | `prod` | the production deploy |

Nothing else is a source of truth: `npm run secrets:sync` reads these files and writes
each value to the store `src/config/manifest.ts` assigns it. Every `.env*` file is
gitignored.

---

## Do it in this order

Each step is independent after the first, so stop whenever the file is complete enough
for what you want to run.

| # | Get | Unlocks | Time |
|---|---|---|---|
| 1 | `DATABASE_URL` (Neon) | the app boots; migrations run | 5 min |
| 2 | `LLM_API_KEY` + two model ids | guests get replies | 2 min |
| 3 | `GUEST_COOKIE_SECRET`, `GUEST_PUBLIC_URL` | the public chat routes stop answering 503 | 1 min |
| 4 | `NEON_AUTH_*` | the staff console | 5 min |
| 5 | `EMBEDDING_API_KEY` | retrieval beyond keyword matching | 2 min |
| 6 | `TURNSTILE_SECRET`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | the bot check is real | 5 min |
| 7 | `EMAIL_FROM`, `EMAIL_API_KEY`, `EMAIL_ESCALATION_FALLBACK`, `CONSOLE_BASE_URL` | escalation mail is delivered, not just queued | 10 min + DNS |
| 8 | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `API_URL` | the deploy pipeline | 5 min |

Steps 2–7 are **required for staging and prod** and merely recommended for local.
A local file missing them still boots; the affected route answers 503 and names what
is absent.

---

## 1. Database — `DATABASE_URL`

**Cost:** Neon's free tier is enough for both environments.

1. Sign in at <https://console.neon.tech>.
2. **Create two separate projects**: `concierge-staging` and `concierge-prod`.

   > **Not two branches of one project.** A branch is a copy-on-write fork that shares
   > the parent's compute and cluster, so W00-13's "three separate databases" would be
   > satisfied on paper only. The staging branch already in use
   > (`br-red-recipe-b42k56zk`) was created with a 7-day expiry policy on 2026-10-22 —
   > by that record it stops existing around **2026-10-29**. Two projects have no such
   > clock.

3. In each project, click **Connect**.
4. Turn **Connection pooling off** and copy the string. The host then has no `-pooler`
   suffix.

   > **Why direct and not pooled.** `npm run db:migrate` runs with this same value, and
   > Neon documents the pooler as unsuited to migrations (`CREATE EXTENSION`,
   > `SET search_path`, DDL in a transaction). One URL that does both is worth more
   > than a pooler this server — a single Node process with its own pool — does not
   > need. See <https://neon.com/docs/connect/connect-from-any-app>.

5. Paste it into `DATABASE_URL` in that environment's file.

Shape: `postgresql://<role>:<password>@<host>/<db>?sslmode=require`

**Local** already has a value that matches `compose.yml`; leave it alone.

---

## 2. Staff sign-in — `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`, `NEON_AUTH_ISSUER`, `NEON_AUTH_AUDIENCE`

This is what verifies a staff member's token. Without it every staff route answers
`503 {"detail":"NEON_AUTH_JWKS_URL is required"}`.

1. In the same Neon project: **Auth** (Neon Auth / Managed Better Auth) → enable it for
   the branch you use.
2. Copy the **Auth URL**. It looks like
   `https://<endpoint>.neonauth.<region>.aws.neon.tech/<db>/auth`.
   Put it in `NEON_AUTH_BASE_URL`.
3. Set `NEON_AUTH_JWKS_URL` to that URL plus `/.well-known/jwks.json`:

   ```text
   https://<endpoint>.neonauth.<region>.aws.neon.tech/<db>/auth/.well-known/jwks.json
   ```

   Confirm it is real before moving on — it must return JSON with at least one key:

   ```bash
   curl -s "$NEON_AUTH_JWKS_URL" | head -c 200
   ```

4. Leave `NEON_AUTH_ISSUER` empty for now. The code falls back to
   `NEON_AUTH_BASE_URL`. Leave `NEON_AUTH_AUDIENCE` empty too; it falls back to the
   issuer.

   > **If staff sign-in fails with `issuer mismatch`,** that fallback was wrong for your
   > installation. Neon issues more than one kind of token: its JWT-plugin tokens carry
   > the Auth URL's **origin** as `iss`, while OAuth access tokens carry the **full Auth
   > URL** (<https://neon.com/docs/auth/guides/plugins/jwt>). Do not guess — decode one
   > real token (any JWT debugger) and paste its `iss` value into `NEON_AUTH_ISSUER`
   > exactly.

Reference: <https://neon.com/docs/auth/guides/plugins/jwt>

---

## 3. The public guest chat — `GUEST_COOKIE_SECRET`, `GUEST_PUBLIC_URL`

**`GUEST_COOKIE_SECRET`** signs the anonymous guest cookie. Generate it yourself; it
never comes from a vendor:

```bash
openssl rand -base64 32
```

Minimum 32 characters — the loader refuses anything shorter, because a short signing
key is a guess away from no signing key. Use a **different** value per environment.

**`GUEST_PUBLIC_URL`** is the origin a printed QR code encodes. A bare origin: scheme
and host, no path, no trailing slash. `https://chat.yourproperty.com`, or the Vercel
preview origin while staging has no domain.

---

## 4. The model — `LLM_API_KEY`, `LLM_PRIMARY_MODEL`, `LLM_FALLBACK_MODEL`

1. Go to <https://aistudio.google.com/apikey> and sign in with a Google account.
2. **Create API key** → pick (or let it create) a Google Cloud project → copy it.
   Keys start with `AIza`.
3. Paste into `LLM_API_KEY`.

Leave the two model ids as shipped unless you have a reason:

```text
LLM_PRIMARY_MODEL=gemini-2.5-flash
LLM_FALLBACK_MODEL=gemini-2.5-flash-lite
```

They are pinned on purpose. `loadLlmConfig` **refuses** a value ending in `-latest`,
because the same alias is a different model six months from now.

> **These two ids are two generations behind as of October 2026.** The models page
> (<https://ai.google.dev/gemini-api/docs/models>) lists Gemini 4 Argon and Gemini 3.8
> Flash as current; `gemini-2.5-flash` and `gemini-2.5-flash-lite` are still served,
> under their own sections. The pair stays the default here because it is the pair the
> prompts, the eval set and the tests were built against — switching a model is a
> measurement, not a paste. If you want the newer generation, swap both ids and re-run
> `npm run eval` before deciding; the loader only requires that whatever you set is
> pinned.

The rest have working defaults — `LLM_BASE_URL`, `LLM_TIMEOUT_MS` (8000),
`LLM_RETRIES` (2, max 4). Change them only if a measurement says to.

---

## 5. Retrieval — `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`

Without a key the product still answers, using keyword and trigram matching instead of
vector search. It is required in staging and prod so that "the good path" is the one
you actually run.

1. Go to <https://platform.openai.com/api-keys> → **Create new secret key** → copy it
   (shown once).
2. Paste into `EMBEDDING_API_KEY`.

Keep `EMBEDDING_MODEL=text-embedding-3-small`: the `vector(1536)` column is locked to
its dimensions, and a different model fails in `assertEmbeddingDimension` before it
reaches Postgres. Defaults: `EMBEDDING_BASE_URL`, `EMBEDDING_TIMEOUT_MS` (20000),
`EMBEDDING_BATCH_SIZE` (16, max 128).

---

## 6. Bot check — `TURNSTILE_SECRET`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`

Both keys come from **one** Cloudflare widget, and they are not interchangeable.

1. Sign in at <https://dash.cloudflare.com> → **Turnstile** in the sidebar.
2. **Add widget** → name it → add the hostname the chat is served from → mode
   *Managed* → **Create**.
3. Copy **Site Key** and **Secret Key**:
   - **Secret Key** → `TURNSTILE_SECRET` (GitHub Environment, the server verifies with it)
   - **Site Key** → `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (Vercel, the browser renders with it)

Walkthrough: <https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/>

**Staging can use Cloudflare's published test pair** and skip widget setup entirely:

```text
TURNSTILE_SECRET=1x0000000000000000000000000000000AA            # always passes
NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
```

A test site key emits the dummy token `XXXX.DUMMY.TOKEN.XXXX`; only a test secret
accepts it, and a real secret rejects it. **Use both halves or neither** —
mixing them fails every check for a reason that looks like a broken widget.
Reference: <https://developers.cloudflare.com/turnstile/troubleshooting/testing/>

`TURNSTILE_TIMEOUT_MS` defaults to 3000 and needs no attention.

---

## 7. Escalation email — `EMAIL_FROM`, `EMAIL_API_KEY`, `EMAIL_ESCALATION_FALLBACK`, `CONSOLE_BASE_URL`

1. Sign in at <https://resend.com/api-keys> → **Create API key** → permission
   **Sending access** (not full access; this key never needs to manage anything) →
   optionally restrict it to your domain → copy it into `EMAIL_API_KEY`.
2. Verify a domain at <https://resend.com/domains> → **Add Domain** → add the DNS
   records it prints (SPF and DKIM) → wait for *Verified*.
3. `EMAIL_FROM` = an address **at that verified domain**:
   `Concierge <desk@yourdomain.com>`. A display name is allowed here.

> **The `resend.dev` trap.** Until a domain is verified, the only usable sender is
> `onboarding@resend.dev`, and it delivers **only to the address on your own Resend
> account**. Every other recipient is rejected with a 403 that reads like a bug.
> That is fine for one staging smoke test and fatal in production — which is exactly
> why `EMAIL_FROM` has no default and is required in every environment.
> <https://resend.com/docs/knowledge-base/403-error-resend-dev-domain>

`EMAIL_ESCALATION_FALLBACK` is where a request goes when the property configured no
email contact of its own. A **bare address**, no display name — this one is parsed
strictly. Pick an inbox somebody actually reads.

`CONSOLE_BASE_URL` builds the link in that email: the absolute `https://` base of the
staff console. Point it at a host the recipient can reach — locally it defaults to
`http://localhost:3000`, which is useless to anyone else.

---

## 8. Deploy plumbing — `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `API_URL`

These live at **repository** level, once, because a single Vercel project serves both
environments. `API_URL` is per environment.

| Value | Where |
|---|---|
| `VERCEL_TOKEN` | <https://vercel.com/account/settings/tokens> → **Create** → scope it to the team that owns the project → copy (shown once). Starts with `vcp_`. |
| `VERCEL_PROJECT_ID` | Project → **Settings → General** → scroll to **Project ID**. Starts with `prj_`. |
| `VERCEL_ORG_ID` | Team → **Settings → General** → **Team ID**. Starts with `team_`. For a personal (Hobby) account it is your account ID under Personal Settings. |
| `API_URL` | The deployed origin of this environment's API — the same value as `REVIEW_API_URL`, but read by CI's smoke step rather than by the Next server. |

Docs: <https://vercel.com/docs/accounts/access-tokens> ·
<https://vercel.com/docs/project-configuration/general-settings>

The org and project ids are **not secrets** — they appear in dashboard URLs — so they
are placed as GitHub *variables*, not secrets. Only the token is a secret.

---

## 9. Rarely touched

| Variable | Leave it unless… |
|---|---|
| `AI_FAIL_MODE` | you are testing the outage path. `none` \| `once` \| `always`. Refused when `APP_ENV=prod`. |
| `ALLOW_DEGRADED_BOOT` | a staging preview host must boot with gaps. Refused in prod. |
| `SENTRY_DSN` | W00-14 has wired a reporter. Until then it is documented and unenforced. Get it from <https://sentry.io/settings/projects/> → project → **Client Keys (DSN)**. |
| `LOG_LEVEL`, `APP_NAME` | you want a different verbosity or two deployments distinguishable in one log sink. |

---

## 10. Platform plumbing — `HOST`, `PORT`, `SMOKE_PROPERTY_SLUG`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL_S3`, `NEON_FUNCTION_HELLO_BASE_URL`

Declared in the contract so a coverage test can see them, and required by **no**
stage yet — no environment runs `src/server.ts` until a host is chosen (issue #153).
Every reader below defaults or fails at its own route, never at boot.

| Value | Where |
|---|---|
| `HOST`, `PORT` | The hosting convention injects these (defaults `127.0.0.1:3000`). |
| `SMOKE_PROPERTY_SLUG` | Optional. Which property `npm run smoke` scores; defaults to `demo`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | The asset bucket's credential pair, from whatever host runs the API. `/healthz/storage` and the asset routes throw `StorageEnvError` without it. |
| `AWS_REGION` | Region of that bucket. |
| `AWS_ENDPOINT_URL_S3` | The S3-compatible endpoint (Neon's asset storage). |
| `NEON_FUNCTION_HELLO_BASE_URL` | The Neon Function that `/healthz/function` probes; absent, that probe reports the failure honestly. |

---

## Verify, then publish

```bash
# 1. is the file complete for this environment?
npm run check:readiness -- --env staging --file .env.staging

# 2. what would be written where? (no network writes, no values printed)
npm run secrets:sync -- --env=staging --env-file=.env.staging --dry-run

# 3. do it
npm run secrets:sync -- --env=staging --env-file=.env.staging

# 4. ask the stores, not the file
npm run check:secrets -- --env staging

# 5. the W00-13 exit criterion: three different databases
npm run check:env -- --staging .env.staging --prod .env.production --local .env
```

Read step 1 as a list, not a yes/no: every gap is named in one pass with the
consequence, and a secret appears as `set`, never as its value.

---

## When it goes wrong

| Message | It means | Fix |
|---|---|---|
| `required in staging and absent` | the file has no value under that name | add it; the message names the consequence |
| `looks like a placeholder, not a configured secret` | the value is `changeme`, `xxx`, `test`, … | paste the real one |
| `the file declares APP_ENV=local but is being checked as staging` | you copied a file and forgot to edit `APP_ENV` | set it to match the file name |
| `NEON_AUTH_JWKS_URL is required` | auth is unconfigured | step 2 |
| `issuer mismatch` | the token's `iss` is not what the code expects | set `NEON_AUTH_ISSUER` to the token's exact `iss` |
| `GUEST_COOKIE_SECRET … at least 32 characters` | the secret is too short | `openssl rand -base64 32` |
| `must be a dated, pinned model id, not the floating alias` | the model id ends in `-latest` | use a pinned id from step 4 |
| `EMAIL_FROM does not look like an address` | display-name syntax used where only a bare address is accepted | `EMAIL_ESCALATION_FALLBACK` takes a bare address only |
| `CONSOLE_BASE_URL must be an http(s) URL` | missing the scheme | `https://…` |
| Resend `403 … only send testing emails to your own email address` | using `onboarding@resend.dev` | verify a domain (step 7) |
| Turnstile always fails with valid keys | site key and secret are from different widgets, or a test key is paired with a live one | use both halves of the same pair |
| `check:env FAILED: staging and prod must NOT share a database` | both files point at one database | two Neon projects, step 1 |

---

## Two rules that are not negotiable

1. **One name, one environment.** `DATABASE_URL` in every file. The deploy picks the
   value by which GitHub Environment the job runs in. `STAGING_DATABASE_URL` and
   `PROD_DATABASE_URL` do not exist, are not read by anything, and will not be added —
   a suffixed name is a second place for the truth to be wrong.
2. **Never commit a filled-in file.** `.gitignore` covers `.env`, `.env.local`,
   `.env.staging`, `.env.production` and every other `.env.*` except this template.
   `npm run check:secrets` and `secrets:sync` never print a value; keep it that way in
   your shell too — no `echo $LLM_API_KEY`, no screenshots of the file.
