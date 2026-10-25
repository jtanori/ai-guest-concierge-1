---
id: S06-03
title: Evaluation harness + CI job
sprint: S06
epic: S06 - Guest chat and evaluation
track: Eng
estimate_days: 1.5
priority: P0
depends_on: [S05-02]
labels: [sprint:S06, track:foundation, prio:P0]
milestone: S06 - Guest chat and evaluation
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/78
pickup: decision
---

# S06-03 — Evaluation harness + CI job

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S06 |
| Track / days / priority | Eng · 1.5d · P0 |
| Depends on | S05-02 |
| Pickup | `decision` |

## 1. Why / goal

G2 must be a number, not an opinion; the harness runs on every prompt/model/knowledge change.

## 2. Acceptance criteria (backlog AC verbatim)

> G2 passes on the fixture property; runs on every prompt change.

- **AC-1** `npm run eval` loads the golden CSV, runs every question through the real pipeline with an injectable provider, and scores four ways.
- **AC-2** CI fails on regression: false-answer >2% or correct-or-escalation <95%.
- **AC-3** Nightly canary against the live property (config, no secrets in logs).

## 3. Scope

**In:** Harness, scorer, thresholds, CI workflow, canary script.

**Out:** Writing the 40 questions (hotel/G1); manual 50/week accuracy audit.

## 4. Calculated changes (for the coding agent)

- `src/eval/harness.ts`: `runEval(questions: GoldenQuestion[], answer: AnswerFn, opts)` → `EvalResult {correctAnswer, correctEscalation, falseAnswer, needlessEscalation, misses[]}`; `expected_behaviour` comes from `src/golden/validate.ts::loadGoldenQuestions` (already parses the 6-column CSV).
- `scripts/eval.ts`: load `data/golden/golden-questions-v2.csv`, build a **fake `AiProvider`** for CI determinism (fixture responses keyed by topic) plus a `--live` flag for the nightly canary; print a markdown table and exit 1 on threshold breach. Add `"eval": "node --experimental-strip-types scripts/eval.ts"` to `package.json`.
- `.github/workflows/eval.yml`: job `eval` on `pull_request` paths `src/ai/**`, `src/knowledge/**`, `data/golden/**`, `.github/workflows/eval.yml`; plus `schedule: nightly` canary. No LLM key in PR CI (fake provider); the key is a repo secret used only by the canary.
- `src/eval/thresholds.ts`: constants from plan Appendix D (`FALSE_ANSWER_MAX=0.02`, `CORRECT_OR_ESCALATION_MIN=0.95`, `CORRECT_ESCALATION_MIN=0.90`, `NEEDLESS_ESCALATION_MAX=0.20`) — a single source so the runbook and CI cannot drift.
- Record the four scores in `docs/runbook.md` and add a `G2` evidence block; the sprint gate is a hard stop.

## 5. Tenancy & security

Eval runs as the demo tenant; the canary must use a dedicated read-only property context and never emit guest PII into CI logs.

## 6. Test plan (named cases)

- `tests/eval/harness.test.ts`: fabricated results for all four buckets, threshold boundary (2.00% passes, 2.01% fails), missing `target_topic` handling.
- `tests/golden/validate.test.ts` (exists) for v2 CSV validation.

## 7. Evidence to record in the runbook

- ``npm run eval` (four scores)`
- `CI `eval` job log`
- `nightly canary log`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **Needs golden set v2 (G1) and DEC-2's provider.** Harness, thresholds and CI wiring are fully calculated; the pass number waits on hotel content.
- The fake provider in CI is a deliberate choice — record it as an open question in charter §9 so reviewers know live G2 proof needs the canary.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
