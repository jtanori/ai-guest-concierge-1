# Phase B handover — commands you run, then the W00 ACs close

Everything below needs a credential or a cloud account I asked not to assume.
Run the blocks in order; each one closes the named acceptance criterion and
shows you the evidence to expect. Nothing here changes the plan.

## B1 — Host repo + protect main (W00-11)

```powershell
# 1. Create the GitHub repo (public private as you prefer):
gh repo create <ORG>/ai-guest-concierge --private --source . --remote origin
git push -u origin main

# 2. Apply branch protection (Git Bash or WSL):
ORG=<ORG> REPO=ai-guest-concierge ./scripts/protect-main.sh

# 3. Attach the three CI checks (they exist now that ci.yml branches exist):
gh api -X PUT repos/<ORG>/ai-guest-concierge/branches/main/protection/required_status_checks `
  -f strict=false -f "contexts[]=lint" -f "contexts[]=typecheck" -f "contexts[]=test"

# 4. THE AC TEST — a direct push to main must be rejected:
git commit --allow-empty -m "protection probe"; git push origin main
#   Expect: refused with "GH006: Protected branch update failed". Then:
git reset --hard origin/main
```

**Evidence to keep:** the GH006 rejection output.

## B2 — CI green check + preview URL (W00-12)

Vercel re-linked under **jtanori**: org `team_MyTwcVzABQrWXY7JvB8qqhlS`, project `prj_3Ir8unz07uhUxzicUi5uHfMGhdx5` (supersedes the bretudev ids in the runbook entry). Preview URL path unchanged below.

```powershell
# 1. Open the throwaway PR (their first run exercises Actions):
git checkout -b ci-probe; git push -u origin ci-probe
gh pr create --title "ci probe" --body "W00-12 AC: PR → green check + preview URL"

# 2. Confirm lint / typecheck / test are green:
gh pr checks
```

**Preview URL:** Vercel account + project link are **done** (`vercel login` → bretudev; `vercel link` → `ai-guest-concierge-1`; ids: `team_qLKXDE77edvQ4sVhisBIxmJI` / `prj_TpEZGM0RCvd0mf9HPDiRkbH0Io6a`). Once the repo from B1 exists, EITHER import it in vercel.com (Git integration) OR keep CLI-based CI by adding `VERCEL_TOKEN` (+ the two ids above) to GH repo secrets — then say so, and I replace the `preview` stub in `.github/workflows/ci.yml` with the Vercel deploy step so the PR carries the URL; the AC closes when the probe PR shows both.

**Evidence to keep:** the `gh pr checks` output + the preview URL.

## B3 — Two cloud databases, provably separate (W00-13)

```powershell
# 1. Neon (recommended — serverless, per-branch DBs, free tier suffices):
#    create TWO projects: "concierge-staging" and "concierge-prod".
#    Copy each connection string.

# 2. THE AC TEST (substitute real URLs; values never leave your shell):
$env:STAGING_DATABASE_URL = "postgres://...staging..."
$env:PROD_DATABASE_URL    = "postgres://...prod..."
$env:LOCAL_DATABASE_URL   = "postgres://concierge:concierge@localhost:54329/concierge_local"
npm run check:env
#   Expect: "OK — no shared databases:" with two masked URLs.
#   If staging and prod share anything, it refuses instead.
```

**Evidence to keep:** that output.

## B4 — Error tracking (W00-14)

```powershell
# 1. Sentry (free dev tier): create org "concierge", project "staging".
#    Copy the DSN into staging env vars.
# 2. After B2's preview is live, I add a debug/throw route with the smoke
#    headers (runbook → W00-14), you trigger it and confirm the Sentry event
#    carries org_id, property_id, conversation_id.
```

**Evidence to keep:** the Sentry event screenshot showing the three fields.

## B5 — Local Postgres (blocks nothing this week, blocks S01)

Docker Desktop's engine was not responding this session (it hung at `docker
info`); the daemon likely needs a full restart of Docker Desktop (or
`wsl --shutdown` if it stays wedged). Then:

```powershell
docker compose up -d
docker compose ps                 # expect "healthy"
npm run check:env                 # still OK with the local URL
```

## Founder-side reminders (not mine, but G0 depends on them)

- ADRs D1–D14: still unsigned in `05-kickoff-pack-week0.md` §2. Send me the approver name + date and I will mark them Accepted in the file and commit it. D1/D5/D11/D14 first.
- W00-15's AC says "file format agreed": confirm the Appendix-A format + 20-question set and I flip it to ✅ Done in the workbook.
- W00-16 (baseline log), W00-18 (privacy/DPA), W00-20 (G0 review) — Founder track, yours.
