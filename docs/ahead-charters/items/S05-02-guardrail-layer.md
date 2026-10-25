---
id: S05-02
title: Guardrail layer
sprint: S05
epic: S05 - AI core and evaluation
track: Eng
estimate_days: 2.5
priority: P0
depends_on: [S05-01]
labels: [sprint:S05, track:foundation, prio:P0]
milestone: S05 - AI core and evaluation
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/74
pickup: decision
---

# S05-02 — Guardrail layer

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S05 |
| Track / days / priority | Eng · 2.5d · P0 |
| Depends on | S05-01 |
| Pickup | `decision` |

## 1. Why / goal

The G2 hard stop: no false answer survives the gate on the golden set.

## 2. Acceptance criteria (backlog AC verbatim)

> No false answer survives the gate on the golden set.

- **AC-1** Every `decision=answer` has ≥1 citation in the retrieved set and every quote is entailed by its cited chunk.
- **AC-2** Banned content (prices, availability, 'confirmed', 'on the way') and policy/sensitive topics escalate with a `reason_code`.
- **AC-3** False-answer ≤2%, correct-or-correct-escalation ≥95% (G2).

## 3. Scope

**In:** Citation verification, banned-content regexes, sensitive-topic classifier, policy gate, reason codes, escalation state.

**Out:** Manual 50/week accuracy audit (S12/pilot); golden set content (G1).

## 4. Calculated changes (for the coding agent)

- `src/ai/guard.ts`: `verifyAnswer(output: AiOutput, retrieved: RetrievalHit[]): {ok: boolean; reasonCode: ReasonCode}` — assert each `citation.article_version_id ∈ retrieved`, quote is a normalised substring of that version's body/chunk, `decision='answer'` ⇒ citations non-empty, and `confidence` above the configured floor.
- `src/ai/banned.ts`: compiled patterns for invented prices/availability (`/\b\d[\d.,]*\s?(mxn|usd|eur|pesos)\b/i`, `'confirmed'`, `'on the way'`, `'we have a room'`, `'booked'`), plus a Luhn-card detector shared with S11-03 (`src/security/pii.ts`). A match → `needs_human` with `reason_code: 'policy_block'`.
- `src/ai/sensitive.ts`: `classify(text, language)` → `sensitive_topic | booking_intent | guest_asked_human` for refunds, medical, accessibility, allergens, complaints; Spanish + English keyword sets (plan §3). Every rejection logs a `reason_code` — no silent fallbacks.
- `src/ai/policy.ts`: combine `escalationDecision(settings, {aiMode, topicKey, at, timeZone})`, `isTopicEnabled`, `spendCaps` and the daily spend counter (S07-04) into one `PolicyGate`; `mode=draft|human_only` always escalates.
- `src/ai/answer.ts` (S05-01): on any failure write `ai_runs(decision='escalate'|'no_answer', reason_code=...)`, insert a `knowledge_gaps` row for `no_answer` with the verbatim question + language, and return the `guest.idontknow` catalogue string — never the model text.
- **Fact contradiction:** if `listContradictions` reports a verified/unverified disagreement for the resolved topic, escalate with `reason_code: 'contradiction'` rather than answering from one side (contract from PR #32).

## 5. Tenancy & security

Guardrail decisions are tenant-scoped through settings (`loadPropertySettings`). Never log raw guest text at info level; use `bindRequestContext` and redaction.

## 6. Test plan (named cases)

- `tests/ai/guard.test.ts`: citation out of set; quote not entailed; empty citations; banned price; Luhn card; each reason code.
- `tests/eval/harness.test.ts` (S06-03): golden set behaviour scoring with a fake provider, asserting ≤2% false answers.
- `tests/db/ai-runs.db.test.ts`: a rejection still writes an `ai_runs` row with its reason.

## 7. Evidence to record in the runbook

- ``npm run eval` (four scores)`
- ``npm test``
- `CI `eval` job from S06-03`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **G2 proof needs G1 content** (golden set v2 + 25 articles). Guardrail code is calculated; the pass/fail number is not.
- **DEC-2 / PR #32** for the provider and the contradiction feed — interfaces stated, exact calls deferred.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
