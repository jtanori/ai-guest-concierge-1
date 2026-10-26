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
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/83
pickup: done
approved: 2026-10-25
done: 2026-10-25
---

# S07-05 — Outage fallback

| | |
|---|---|
| Sprint | S07 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S07-04 |
| Pickup | `done` |

## 1. Why / goal

Kill the AI mid-conversation; the guest still gets an honest message.

## 2. Acceptance criteria (backlog AC verbatim)

> Kill the AI mid-conversation; guest still gets an honest message.

- **AC-1** Provider failure mid-turn results in `guest.team_will_reply` + a `service_requests` row, never a 5xx or an empty reply.
- **AC-2** `message_failed` event is emitted for observability.

## 3. Scope

**In:** Failure handling in the answer pipeline, honest reply, request creation.

**Out:** Transport retry/circuit breaker (S07-06).

## 4. Calculated changes — what was actually built

- **`src/ai/answer.ts`** — the `AiUnavailableError` branch now records the outage before returning:
  one `ai_runs` row (`decision='escalate'`, `reason_code='provider_unavailable'`, `model_id='none'`,
  `usage={attempts, models, outage}`) and one `message_failed` event, both in the caller's transaction.
  Extracted as `recordOutage()` because the same evidence is owed from the second catch in
  `src/guest/service.ts` (an adapter throwing outside the wrapper).
- **`src/ai/contract.ts`** — `AI_RUN_REASON_CODES` = the model's `AI_REASON_CODES` **plus**
  `provider_unavailable`. `recordAiRun` now validates against it. No migration: `ai_runs.reason_code`
  is unconstrained `text` and the vocabulary was only ever enforced in TypeScript.
- **`src/ai/provider.ts`** — `AiUnavailableError` carries `modelIds` (the models that were *tried*), so the
  outage row can list them in `usage` without naming a model that never answered.
- **`src/ai/chaos.ts`** — `loadChaosMode` / `withChaos`, driven by `AI_FAIL_MODE=none|once|always`.
  Refused outright under `APP_ENV=prod`; the failure it raises is the real `AiUnavailableError`, so the
  path under test is the production path.
- **`src/guest/runtime.ts`** — wraps the built AI with the chaos hook and exposes `aiFailMode`.
- **`.env.example`** — documents `AI_FAIL_MODE`.

## 5. Tenancy & security

The outage path writes through the same tenant-scoped client as the turn that failed, so a failure cannot
land a request in another property's queue; the rollback test proves the evidence disappears with the turn.

## 6. Test plan — what exists now

- `tests/ai/outage.test.ts` (15) — the chaos hook's three modes, the prod refusal, the unknown-value refusal,
  pass-through, "one failure then normal", circuit isolation, and the two-vocabulary rule
  (`provider_unavailable` is **not** a code the model may emit).
- `tests/db/outage.db.test.ts` (5) — the control case; the full AC (honest reply + `service_requests` row +
  `ai_runs`/`message_failed` with the attempted models); the mid-conversation shape answer → outage → *parked
  for a human*; rollback leaves no outage evidence; an invented reason code is refused.

## 7. Evidence (recorded in the runbook)

`npm test` 35 files / 457 · `npm run db:test` 27 files / 237 · tsc/lint/`web:build` clean ·
`npm run eval` unchanged with the regression gate passing · migrations still 19 (no schema change).

## 8. Decisions and deviations

- **`guest.team_will_reply` was not added** (same call as S07-04). `guest.unavailable` already reads
  "I can't answer right now, but I've passed this to the team — a person will reply here shortly", which is
  the sentence the AC asks for, and it is already the string this path sends. A third key saying the same
  thing is how two promises drift apart.
- **`provider_unavailable` went into a second enum, not into `AI_REASON_CODES`.** The charter said "add it to
  the closed reason_code enum used by `guard.ts`" — but that same constant is the enum shipped to the model in
  its JSON schema (`prompt.ts`). Adding it there would let a model *claim* an outage. Two vocabularies, one
  superset, and the superset is the one `recordAiRun` enforces.
- **`model_id = 'none'` on an outage row.** `ai_runs.model_id` is NOT NULL and per-model accuracy is sampled
  from this table; attributing a failure to `gemini-2.5-flash` would put an outage in that model's
  denominator. The attempted ids live in `usage.models`.
- **The recovery is a human, not a silent resume.** After an outage turn the conversation is `awaiting_staff`,
  so the next message is answered with `guest.staff_reply_pending` rather than by the model. That is
  S06-02's state machine doing its job and is asserted in the mid-conversation test.
- **`AI_FAIL_MODE` is prod-refusing, not prod-ignoring.** A silent downgrade would leave a host that believes
  it is injecting failures and is not; a boot error is a five-second fix.

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview`, `web-build` (and `eval` with the gate).
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs`.
- [x] Progress report regenerated with `npm run progress`.
- [x] Cross-tenant isolation unaffected (no new table); no new runtime dependency.
- [x] Review threads resolved; §8 decisions recorded in the runbook.

## 10. Follow-ups this item creates

- **S07-06:** the transport's retry/circuit policy is what decides how often this path is reached; the outage
  counters in `ai_runs` (`reason_code='provider_unavailable'`) are the metric to tune it against.
- **Ops (S11/S12):** `message_failed` is emitted but nothing alerts on it yet — an alert on its rate belongs
  with the reliability item that owns dashboards.
- **S12-02 (staging):** the chaos run belongs in the staging smoke script, not only in tests.
