---
id: S07-06
title: LLM transport resilience
sprint: S07
epic: S07 - Chat hardening
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S05-01]
labels: [sprint:S07, track:foundation, prio:P0]
milestone: S07 - Chat hardening
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/84
pickup: decision
---

# S07-06 — LLM transport resilience

> **CLOSED — implemented and verified.** The decisions this charter left open are recorded in §8 and the close-out is §10; the runbook entry (`docs/runbook.md`) carries the exact commands and counts. §4's calculated file paths were rebased on the tree as it stood when work started — where the code ended up somewhere else, §10 says where and why.

| | |
|---|---|
| Sprint | S07 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S05-01 |
| Pickup | `decision` |

## 1. Why / goal

Both providers killed; product degrades honestly (D12 transport spec).

## 2. Acceptance criteria (backlog AC verbatim)

> Both providers killed; product degrades honestly.

- **AC-1** 8s generation / 3s classification timeouts, two retries with jitter on 429/5xx only, 60s circuit break to the secondary.
- **AC-2** Pinned model versions; provider-native structured outputs + server-side validation.
- **AC-3** Parse-failure rate is an alerting metric.

## 3. Scope

**In:** Transport wrapper, circuit breaker, pinned config, parse-failure metric.

**Out:** New provider features; UI.

## 4. Calculated changes (for the coding agent)

- `src/ai/transport.ts`: `withTimeout(promise, ms)`, `retryOnTransient(fn, {retries:2, jitterMs:[50,250], retryOn:[429,5xx]})`, `CircuitBreaker({openMs:60_000})` — compose around `AiProvider.generate` from S05-01. No dependency.
- Fail **closed**: if primary and fallback are both down, throw `AiUnavailableError` so S07-05's honest-degradation path handles it — never return a partial/garbage answer.
- `src/config/env.ts`: `LLM_PRIMARY_MODEL`, `LLM_FALLBACK_MODEL` must be pinned ids (reject `@latest`/floating aliases with a `ConfigError`); add `LLM_TIMEOUT_MS`, `LLM_RETRIES` with defaults.
- `src/metrics/counters.ts`: `ai_parse_failure_total`, `ai_fallback_total`, `ai_circuit_open_total` counters exposed via the existing `createLogger` (S11-04 turns them into alerts).

## 5. Tenancy & security

Metrics carry `org_id/property_id`, never prompt or guest text.

## 6. Test plan (named cases)

- `tests/ai/transport.test.ts`: 429→retry, 5xx→fallback, both dead→`AiUnavailableError`, no retry on 400, circuit stays open 60s, pinned-alias config rejected.

## 7. Evidence to record in the runbook

- ``npm test``
- `CI log of the injected double outage`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

**CLOSED — decisions.**

- **DEC-2 closed 2026-10-25**: Gemini `gemini-2.5-flash` primary / `gemini-2.5-flash-lite` fallback, pinned ids, plain `fetch`, no SDK. The transport stayed provider-agnostic as planned.
- **Retry budget is configuration, not a constant: `LLM_RETRIES` (default 2, range 0–4).** The ceiling exists because the guest is the one waiting; three retries on an 8s timeout is longer than anybody holds a chat window open.
- **Counters, not timers or histograms.** Alerting needs the rate (failures per turn), which a counter and a denominator give; a metric sink was out of scope, so the sink is an injected logger (`setCounterLogger`) that is a no-op until the server installs one.

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [x] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [x] Review threads resolved; charter §9 decisions recorded in the runbook.

## 10. Close-out

**AC-1 — timeouts, two jittered retries on 429/5xx only, 60s circuit break to the
secondary.** Met. `withResilience(primary, fallback, { retries, sleep, now })` in
`src/ai/provider.ts`; the retry count comes from `LLM_RETRIES` (default 2). Retries
fire on 429 and 5xx and on nothing else — a 400 is a bug in our request and
retrying it just spends the guest's time. After the primary is judged down the
circuit stays open for 60s and the secondary serves. `AiUnavailableError` is thrown
only when both are down, so S07-05's honest degradation handles it: the guest is
told a person will follow up, never handed a partial answer.

**AC-2 — pinned model ids, provider-native structured outputs, server-side
validation.** Met (S05-01 + `src/config/env.ts`): `LLM_PRIMARY_MODEL` and
`LLM_FALLBACK_MODEL` are required with no default and floating aliases are
rejected; the reply is parsed against the answer contract and anything that fails
is a parse failure, not an answer.

**AC-3 — parse-failure rate is an alerting metric.** Met. `src/metrics/counters.ts`
is a closed vocabulary with a label allowlist (`org_id`, `property_id`, `model`)
and four counters: `ai_parse_failure_total`, `ai_fallback_total`,
`ai_circuit_open_total`, `ai_outage_total`. Wired at the points that matter —
circuit open in the provider, fallback / parse failure / outage in
`src/ai/answer.ts`. The sink is injected once at boot (`setCounterLogger` in
`src/server.ts`) and a sink that throws cannot fail a guest turn (wrapped in
try/catch, pinned by a test). **Guest text is dropped, not logged**: a counter
labelled with a question would be a counter that leaks the conversation.

`tests/db/metrics.db.test.ts` drives a scripted provider through the real pipeline
and asserts each counter appears with exactly its label set, and
`tests/metrics/counters.test.ts` covers label bleed, ordering, snapshot copying and
the throwing sink. S11-04 turns these into alerts; nothing here pages anybody yet,
which is why AC-3 is "is a metric" and not "has an alert".

**Evidence:** `tests/metrics/counters.test.ts` 12 passed; `tests/db/metrics.db.test.ts`
3 passed; `src/config/env.test.ts` covers `LLM_RETRIES` (default, range, rejection);
`npm test` 500 passed; `npm run db:test` 243 passed; `npm run lint` and
`npx tsc --noEmit` clean; `npm run web:build` green.
