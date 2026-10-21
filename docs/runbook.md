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

**Evidence (local half, verified):**
```text
$ git log --oneline
6f17696 W00-11/12: project scaffold — npm toolchain, TS config, eslint, ES/EN string catalogue (D14)
bd14424 W00-11: repo governance — gitignore, PR template, branch-protection script, editorconfig, runbook start
```

## W00-12 — CI skeleton: lint, typecheck, test, preview (0.75d)

**AC (verbatim):** A PR produces a preview URL and a green check.

**Status: NOT DONE — remote half pending (Phase B). Local equivalents verified green.**

- [x] Toolchain: TypeScript 5 (strict, NodeNext), vitest 3, eslint 9 (flat config), prettier 3 — npm scripts `lint`, `typecheck`, `test` under Node 24.
- [x] First module ships with its tests and obeys D14: `src/i18n/catalog.ts` — ES/EN string catalogue, key parity enforced by type + runtime test (3/3 pass).
- [x] CI workflow `.github/workflows/ci.yml`: three required contexts (`lint`, `typecheck`, `test`) on every PR; `preview` job stubbed and explicitly marked as a Phase B step.
- [x] Local evidence (below): lint + typecheck + test all green.
- [ ] **YOU (Phase B):** push to GitHub (Actions work when the repo exists); open one throwaway PR → `lint`/`typecheck`/`test` green check.
- [ ] **YOU (Phase B):** create a Vercel account, connect the repo, then replace the `preview` stub in `ci.yml` with the Vercel deploy action (or `amondnet/vercel-action`) so the job returns a real preview URL.
- [ ] **Evidence (AC test):** the throwaway PR shows a green check AND a reachable preview URL. Only then mark Done in the workbook.

**Evidence (local half, verified):**
```text
$ npm run lint        # 0 problems
$ npm run typecheck   # tsc --noEmit, no errors
$ npm test            # 3 passed (3)
```

