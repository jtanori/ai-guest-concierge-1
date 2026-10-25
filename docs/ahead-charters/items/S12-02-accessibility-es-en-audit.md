---
id: S12-02
title: Accessibility + ES/EN audit
sprint: S12
epic: S12 - Pilot readiness
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S08-01]
labels: [sprint:S12, track:foundation, prio:P0]
milestone: S12 - Pilot readiness
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/103
pickup: decision
---

# S12-02 — Accessibility + ES/EN audit

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S12 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S08-01 |
| Pickup | `decision` |

## 1. Why / goal

Lighthouse a11y ≥90; no untranslated strings.

## 2. Acceptance criteria (backlog AC verbatim)

> Lighthouse a11y >=90; no untranslated strings.

- **AC-1** Lighthouse accessibility ≥90 on the guest chat and staff inbox.
- **AC-2** Every UI string resolves through `src/i18n/catalog.ts` in ES and EN; a literal-scan test fails otherwise.

## 3. Scope

**In:** A11y fixes, i18n coverage test, Lighthouse CI job.

**Out:** New languages beyond ES/EN (D14).

## 4. Calculated changes (for the coding agent)

- `tests/i18n/no-literals.test.ts`: scan `src/**/*.ts`/`public/**/*.js` for user-facing string literals outside `src/i18n/catalog.ts` (allow SQL, log messages, class names via an explicit allowlist); fail on any new `>Text<` HTML content.
- `src/i18n/catalog.test.ts` (exists) already enforces key parity — extend it to assert every `StringId` is referenced by at least one UI module and every UI `t()` id exists.
- Add `.github/workflows/a11y.yml`: run Lighthouse CI against the staging guest chat + inbox URLs (needs a Lighthouse package — **decision**: devDependency approval, or run `npx lighthouse` in a separate job without committing a dep).
- Fix: semantic landmarks, labelled inputs, focus order, contrast, `aria-live` for new AI messages, keyboard-only handoff button.

## 5. Tenancy & security

No data-path change; the literal scan must not flag SQL or log strings.

## 6. Test plan (named cases)

- `tests/i18n/no-literals.test.ts`
- `tests/i18n/catalog.test.ts` (parity + usage)
- Lighthouse CI job

## 7. Evidence to record in the runbook

- `Lighthouse a11y score ≥90`
- ``npm test` (literal scan)`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-1 (UI framework)** determines the markup to audit and whether Lighthouse CI is feasible; the i18n tests are framework-independent and can land early.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
