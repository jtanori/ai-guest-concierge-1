---
id: S07-05
title: Outage fallback
sprint: S07
epic: S07 - Chat hardening
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S07-04]
labels: [sprint:S07, track:foundation, prio:P0]
milestone: S07 - Chat hardening
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/83
pickup: ready
---

# S07-05 — Outage fallback

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S07 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S07-04 |
| Pickup | `ready` |

## 1. Why / goal

Kill the AI mid-conversation; the guest still gets an honest message.

## 2. Acceptance criteria (backlog AC verbatim)

> Kill the AI mid-conversation; guest still gets an honest message.

- **AC-1** Provider failure mid-turn results in `guest.team_will_reply` + a `service_requests` row, never a 5xx or an empty reply.
- **AC-2** `message_failed` event is emitted for observability.

## 3. Scope

**In:** Failure handling in the answer pipeline, honest reply, request creation.

**Out:** Transport retry/circuit breaker (S07-06).

## 4. Calculated changes (for the coding agent)

- `src/ai/answer.ts`: wrap the provider call in `try/catch`; on `AiUnavailableError`/timeout → `captureRequest` (S07-03) with `topic='ai_outage'`, persist an outbound message with `t('guest.team_will_reply')`, write `ai_runs(decision='escalate', reason_code='provider_unavailable')`, emit `message_failed` — all in one transaction.
- Add `provider_unavailable` to the closed `reason_code` enum used by `src/ai/guard.ts` and to `ai_runs.reason_code` documentation.
- Add a chaos hook `AI_FAIL_MODE=always|once|none` (config gated to non-prod) so CI/staging can prove the path without killing a real provider.

## 5. Tenancy & security

Failure path must not write to another tenant's request queue; reuse the guest-derived context.

## 6. Test plan (named cases)

- `tests/ai/outage.test.ts`: provider throws mid-turn → honest reply + request + event, no 5xx.
- `tests/db/outage.db.test.ts`: transaction atomicity when the event insert fails.

## 7. Evidence to record in the runbook

- ``npm test``
- `staging chaos run with `AI_FAIL_MODE=always` (transcript in runbook)`

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — depends on S07-04's degradation message and S07-03's capture service only.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
