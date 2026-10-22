# Phase B handover — commands you run, then the W00 ACs close

Everything below needs a credential or a cloud account I asked not to assume.
Run the blocks in order; each one closes the named acceptance criterion and
shows you the evidence to expect. Nothing here changes the plan.

## B1 — Host repo + protect main (W00-11) — done

```text
1. Repo created + pushed:
   gh repo create jtanori/ai-guest-concierge-1 --source . --remote origin --push
2. Made public (private-repo protection needs GitHub Pro):
   gh repo edit jtanori/ai-guest-concierge-1 --visibility public --accept-visibility-change-consequences
3. Protection applied via `gh api` (bash not available on this Windows box —
   scripts/protect-main.sh documents the equivalents): PRs required, 1 approving
   review, stale reviews dismissed, admins bound, linear history, no force-push/deletes.
4. AC evidence: `git push origin main` → `GH006: Protected branch update failed ...
   Changes must be made through a pull request.`
```

**Evidence kept:** the GH006 rejection output (quoted in `docs/runbook.md`, W00-11 section).

## B2 — CI green check + preview URL (W00-12)

Vercel is re-linked under **jtanori**: org `team_MyTwcVzABQrWXY7JvB8qqhlS`, project `prj_3Ir8unz07uhUxzicUi5uHfMGhdx5`. Preview URL wiring below.

```powershell
# 1. Open the throwaway PR (their first run exercises Actions):
git checkout -b ci-probe; git push -u origin ci-probe
gh pr create --title "ci probe" --body "W00-12 AC: PR → green check + preview URL"

# 2. Confirm lint / typecheck / test are green:
gh pr checks
```

**Preview URL:** done — account + project + repo are connected (jtanori). Implementation: repo secrets `VERCEL_TOKEN` / `VERCEL_ORG_ID` (`team_MyTwcVzABQrWXY7JvB8qqhlS`) / `VERCEL_PROJECT_ID` (`prj_3Ir8unz07uhUxzicUi5uHfMGhdx5`) + `vercel deploy` step in `ci.yml` that probes the deployment (see W00-12 runbook entry for the full debug trail, including why `vercel.json` pins `@vercel/node`). Every PR now ships a preview URL automatically; Deployment Protection (SSO) is off so URLs are publicly reachable. Earlier notes naming `bretudev` ids are superseded.

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
