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
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/84
pickup: decision
---

# S07-06 — LLM transport resilience

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

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

Open decisions / blockers:

- **DEC-2 (providers/models).** The transport mechanism is fully calculated and provider-agnostic; concrete endpoints/keys wait on the decision.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
