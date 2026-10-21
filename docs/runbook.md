# Runbook — W00 and beyond

Written as items are worked, not at the end. One entry per backlog item.

## W00-11 — Repo, branch protection, org setup (0.50d)

**AC (verbatim):** A direct push to main is rejected.

**Status: NOT DONE — local half complete, remote half pending (Phase B).**

- [x] Local: `git init -b main` in project root (was not a repo).
- [x] Local: `.gitignore` — rejects `.env*` (except `.env.example`), node_modules, dist, coverage.
- [x] Local: PR template `.github/pull_request_template.md` — item ID + verbatim AC + evidence checklist + isolation/i18n notes.
- [x] Local: `.editorconfig` (LF, utf-8, 2-space).
- [x] Local: `scripts/protect-main.sh` — the exact `gh` call that applies branch protection once the remote exists.
- [ ] **YOU (Phase B):** create the `ai-guest-concierge` repo on GitHub, add the remote:
  ```powershell
  git remote add origin git@github.com:<ORG>/ai-guest-concierge.git
  git push -u origin main
  ```
  then run `ORG=<org> REPO=ai-guest-concierge ./scripts/protect-main.sh` (needs Git Bash or WSL; requires `gh` authenticated as admin).
- [ ] **Evidence (AC test):** `git push origin main` from a working tree with no open PR → refused with `GH006` / `remote: error: gh006: Protected branch update failed`.

**Notes.** No CI contexts are attached until W00-12's workflow exists (the script prints the follow-up command). Admins are bound (`enforce_admins: true`) so the rule applies to the founder too.
