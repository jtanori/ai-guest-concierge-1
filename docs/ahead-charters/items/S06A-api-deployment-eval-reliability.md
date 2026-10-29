---
id: S06A
title: API, deployment and eval reliability
epic: S06A - API, deployment and eval reliability
track: Eng
estimate_days: 14.5
priority: P0
depends_on: [S06-03]
labels: [sprint:S06A, track:foundation, prio:P0]
milestone: S06A - API, deployment and eval reliability
status: approved
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/166
pickup: approved
approved: 2026-10-29
---

# S06A — API, deployment and eval reliability

**Owner authorization:** The user requested this epic be started ASAP on 2026-10-29. This is an approved interstitial epic; external account changes and production cutovers remain gated by explicit verification and safe rollout criteria.

## Goal

Between S06 and S07, make answer-quality measurements trustworthy and resolve the product's actual API/deployment boundary. Simplify toward Git-integrated Vercel deployments if project settings can meet the CI and secret-isolation requirements. Do not do a broad rewrite or turn unknowns into assumptions.

## Evidence and assertions to test

Owner-reported live run #40837948865, following PR #163 and corpus expansion, used golden v1 (20 questions: 13 answer-expected, 7 escalation-expected): false answers 0/20; correct escalation 7/7; correct-or-escalated 12/20 (60%); needless escalation 8/13 (61.5%). Thus the reported run misses the 95% correct-or-escalated and 20% needless-escalation requirements. At 20 rows a single false answer represents 5%; the false-answer cap is not meaningfully armed until the evaluator's minimum of 50.

The reported causal categories are guardrail overmatch, multilingual retrieval gaps, missing question-to-structured-fact routing, and at least one model refusal. They are working hypotheses until a new trace attributes each row. In particular, `observedFrom()` in `scripts/eval.ts` returns `topics: []` for every `escalate` and `no_answer`, and `scoreEval()` uses those topics for retrieval recall. An early guardrail return is not evidence that retrieval ran and returned zero hits.

Static code facts verified during audit:

- `src/ai/answer.ts` calls `classifySensitive()` before fact lookup or retrieval.
- `src/ai/sensitive.ts` has a `booking_intent` match for “how much”; this may conflate service-price questions with transaction intent.
- `AnswerMessageInput` supports structured input/topic, but the eval `judge()` supplies `topicKey: null`, no `structured`, and explicitly avoids using golden `targetTopic` as a runtime label.
- `MIN_QUESTIONS_FOR_GATE` is 50. A 50-question set has 2% granularity; this is a minimum for expressing the threshold, not a claim of statistical certainty.
- The source route groups exist, but current `api/` entry files do not expose all guest/staff groups. Issue #153 already records this gap.

## Stories / estimates

| Story | Estimate | Work |
|---|---:|---|
| #167 / S06A-01 | 1.50d | Eval attribution and retrieval diagnostics |
| #168 / S06A-02 | 1.50d | Sensitive and policy classifier calibration |
| #169 / S06A-03 | 2.50d | Guest intent classification and structured-fact routing |
| #170 / S06A-04 | 2.00d | Cross-language knowledge and retrieval quality |
| #171 / S06A-05 | 2.50d | API contract and runtime decision |
| #172 / S06A-06 | 3.00d | Native Vercel Git deploys for API and web |
| #173 / S06A-07 | 1.50d | Representative golden set and gate arming |
| **Total** | **14.50d** | Additional to original 70-day estimate |

## Execution sequence

1. **Start #167 and #171 immediately, in parallel.** #167 fixes instrumentation before any retrieval conclusion; #171 builds the real API route inventory and measures runtime feasibility.
2. **#168 and #170** use #167's trace to classify actual refusal causes and run retrieval-only experiments.
3. **#169** follows the safe intent-policy design from #168; facts are selected by an internal constrained classifier, never supplied from golden labels or browser inputs.
4. **#172** follows the API runtime decision from #171. Native Git deployment must be proven in preview/staging before removing current CI/alias workflows.
5. **#173** consumes tested behavior, then arms the absolute G2 gate only after 50+ reviewed cases exist. Keep historical v1 and the supplied live report as comparators.
6. Reforecast launch after the 14.5-day addition. Existing W14 date is not a valid commitment without staffing/parallelism recalculation.

## Assertions and resolution plan

| Assertion | Test/evidence required | Resolution if confirmed |
|---|---|---|
| “How much” blocks fact-backed prices | Trace rule ID and stage for both named questions; unit regression | Restrict booking rule to transactional intent; route approved fact price questions to verified facts |
| Extra-bed/pet cases hit policy/guardrails | Per-row trace and test of classifier/policy reason | Fix only the exact false-positive rule; unsupported content still refuses |
| Spanish query cannot retrieve English topic | Retrieval-only run with language and target-topic labels | Add approved bilingual content or measured query normalization/expansion; retain exact citations/current version/RLS |
| Facts are unreachable in current eval path | Test internal intent classifier and fact lookup with production guest adapter, no target labels | Wire conservative classifier into real request and eval; unknown/missing fact falls back safely |
| “Retrieved nothing” is unreliable | Unit test for early escalation vs empty retrieval vs model refusal | Record `not_run` separately from empty, and compute recall only on retrieval-run rows |
| API is incomplete on Vercel | Route matrix matches handlers, OpenAPI, web callers and deployed adapters | Expose all required routes on selected runtime; keep domain logic independent of framework |
| CI/Vercel deployments compete and pin aliases | Dashboard configuration + controlled failed-check test + staging/prod domain test | Adopt native Vercel Git; retire duplicate CLI deploy/alias logic only after proof |

## Definition of done

- [ ] Current canary run re-produced or explicitly marked not reproducible; every miss has pipeline-stage attribution.
- [ ] No safety guarantees or tests are relaxed to reduce needless escalation.
- [ ] Deterministic and live eval retain exact denominators, version/commit metadata, and outage classification.
- [ ] The absolute ≤2% false-answer gate clearly distinguishes unarmed from pass, and is not called G2-complete below 50 reviewed rows.
- [ ] Full API contract and deployment coverage align; hosting choice is measured and recorded.
- [ ] Git deployment path protects production with required checks and secrets scoped per trust boundary; no alias pinning required.
- [ ] Backlog workbook/Markdown and GitHub epic/issues are reconciled; runbook contains evidence.
