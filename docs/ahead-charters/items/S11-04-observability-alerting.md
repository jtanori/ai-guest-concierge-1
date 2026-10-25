---
id: S11-04
title: Observability + alerting
sprint: S11
epic: S11 - Reliability
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S11-01]
labels: [sprint:S11, track:foundation, prio:P0]
milestone: S11 - Reliability
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/100
pickup: ready
---

# S11-04 — Observability + alerting

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S11 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S11-01 |
| Pickup | `ready` |

## 1. Why / goal

Every alert fires once in staging with a runbook link.

## 2. Acceptance criteria (backlog AC verbatim)

> Every alert fires once in staging with a runbook link.

- **AC-1** Alert definitions cover parse failures, provider fallback, outbox DLQ, cap trips, retrieval-gate rate, and reconciliation drift.
- **AC-2** Each alert names a runbook heading and fires exactly once per incident (dedupe key).

## 3. Scope

**In:** Alert definitions, counter wiring, staging fire drill.

**Out:** Vendor-hosted alerting UI; SLO enforcement.

## 4. Calculated changes (for the coding agent)

- `src/observability/alerts.ts`: `ALERTS` array with `{id, counter, threshold, window, dedupeKey, severity, runbookAnchor}`; counters come from `src/metrics/counters.ts` (S07-06: `ai_parse_failure_total`, `ai_fallback_total`, `ai_circuit_open_total`) plus `outbox_dead_total`, `spend_cap_trip_total`, `retrieval_gate_total`, `embedding_drift_total` (S11-05).
- `src/observability/evaluate.ts`: pure `evaluate(counters, alerts, now)` returning due alerts with a dedupe key = `alertId + windowStart`; wire into `reportError` (`src/logging/index.ts`) so each produces a structured log line with `runbook: docs/runbook.md#<anchor>`.
- Add runbook headings matching every `runbookAnchor` (S12-01 owns the final sign-off). Add a staging fire-drill script `scripts/alert-drill.ts` that injects each counter and asserts exactly one alert line.

## 5. Tenancy & security

Alert payloads carry `org_id/property_id` but never message text; a noisy tenant cannot suppress another's alert (dedupe key includes property).

## 6. Test plan (named cases)

- `tests/observability/alerts.test.ts`: each alert fires once per window, not twice; unknown counter → no crash; runbook anchor exists in `docs/runbook.md`.
- `tests/observability/drill.test.ts`: staging drill output.

## 7. Evidence to record in the runbook

- ``npm test``
- ``node scripts/alert-drill.ts` (staging log excerpt in runbook)`

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — depends on S11-01/S07-06 counters; no external vendor required if alerts are structured logs + the existing `reportError` hook.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
