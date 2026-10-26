---
id: S05-01
title: AI service with structured output contract
sprint: S05
epic: S05 - AI core and evaluation
track: Eng
estimate_days: 2.0
priority: P0
depends_on: [S04-03]
labels: [sprint:S05, track:foundation, prio:P0]
milestone: S05 - AI core and evaluation
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/73
pickup: decision
---

# S05-01 — AI service with structured output contract

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S05 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S04-03 |
| Pickup | `decision` |

## 1. Why / goal

The answer pipeline with a strict JSON contract (D4, hard to reverse) behind one primary + one fallback provider (D12).

## 2. Acceptance criteria (backlog AC verbatim)

> Malformed output rejected server-side, never sent.

- **AC-1** Appendix B contract (`decision|answer|language|citations|reason_code|topic_keys_used|confidence`) validated server-side; any violation → escalate, never send.
- **AC-2** Model ids are pinned (no floating aliases); temperature 0; no tools.
- **AC-3** Every call writes `ai_runs(model_id, prompt_version, ...)` (S05-03).

## 3. Scope

**In:** Contract + validator, provider interface, transport (timeout/retry/circuit break), pipeline orchestration, prompt versioning.

**Out:** Guardrail checks (S05-02); eval harness (S06-03); UI (S06-01).

## 4. Calculated changes (for the coding agent)

- `src/ai/contract.ts`: `AiDecision = 'answer'|'needs_human'|'no_answer'`, `AiOutput` matching plan Appendix B, and `parseAiOutput(raw: unknown): AiOutput` — a hand-written validator (no new dependency) that rejects wrong types, unknown decisions, `answer` without citations, citations without `article_version_id`/`quote`, out-of-range confidence, and unknown `reason_code` values.
- `src/ai/provider.ts`: `interface AiProvider { generate(input: {system: string; prompt: string; schema: object; temperature: 0; timeoutMs: number}): Promise<unknown>; }`, plus `withResilience(primary, fallback)`: 8s generation / 3s classification timeout, two retries with jitter on 429/5xx only, then a 60s circuit break to the secondary. Pinned ids from `src/config/env.ts` (`LLM_PRIMARY_MODEL`, `LLM_FALLBACK_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL`) — add to `AppConfig` with `ConfigError` on missing values when `APP_ENV=prod`.
- `src/ai/answer.ts`: `answerMessage(client, context, {conversationId, messageId, text, language, at})` pipeline — classify → `escalationDecision` / `isTopicEnabled` / `spendCaps` from `src/settings/policy.ts` → `lookupFact` short-circuit → `retrieveCurrentVersions` hybrid → retrieve-gate (`topScore < threshold` → `no_answer`) → generate → S05-02 verify → persist message + `ai_runs` + `citations` in one transaction → emit events.
- `src/ai/prompt.ts`: `PROMPT_VERSION = 'answer-v1'` and a pure `buildPrompt()` so the eval harness can pin prompts; store the version on every `ai_runs` row.
- Use native `fetch` with provider-native structured outputs (`response_format`/JSON schema) **and** server-side `parseAiOutput`; a parse failure increments a `ai_parse_failure_total` counter for S07-06 alerting.

## 5. Tenancy & security

Provider calls carry no tenant id in the prompt; log only `org_id/property_id/conversation_id` via `createLogger` (`src/logging/index.ts`), never message bodies. `ai_runs`/`citations` are tenant tables — add to the isolation suite.

## 6. Test plan (named cases)

- `tests/ai/contract.test.ts`: malformed JSON, wrong decision, empty citations, out-of-set citation, confidence >1, unknown reason_code → rejected.
- `tests/ai/transport.test.ts`: fake providers — 429 → retry, 5xx → fallback, both dead → `AiUnavailableError`.
- `tests/db/ai-runs.db.test.ts`: one `ai_runs` row per call with pinned `model_id` + `prompt_version`.

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``
- `CI `test` job with a stub provider (no live key in CI)`

## 8. Pickup status, blockers and decisions

**IN PROGRESS.** **DEC-2 CLOSED 2026-10-25** by the operator: **Google Gemini**, reached over plain `fetch` (no SDK, consistent with DEC-3). Pinned pair `gemini-2.5-flash` (primary) / `gemini-2.5-flash-lite` (fallback), both required as env values — `loadLlmConfig` has no default model id and refuses `-latest`/`@latest`.

Delivered without it (all provider-agnostic, all tested):

- `src/ai/contract.ts` — Appendix B types plus `parseAiOutput`, a hand-written validator that rejects unknown/missing fields, an undefined decision, an answer with no citations, a citation outside the retrieved set, a bad quote, an out-of-range confidence, an unknown `reason_code`, prose attached to a non-answer, and unretrieved topic keys. It reports EVERY violation in one error rather than the first, and it refuses to map `needs_human` to the table's `escalate` anywhere but `toRunDecision`.
- `src/ai/prompt.ts` — `PROMPT_VERSION = "answer-v1"`, a pure `buildPrompt`, and `AI_OUTPUT_JSON_SCHEMA` for provider-native structured outputs. Articles are labelled with `article_version_id` only (never `article_id`), and `no_answer` is offered to the model explicitly.
- `src/ai/provider.ts` — `AiProvider` + `withResilience`: 8s/3s timeouts enforced on the caller side too, two jittered retries on 429/5xx only, a 60s circuit break to the secondary, `AiUnavailableError` when both fail, and a refusal to accept the same pinned model twice as primary and fallback.
- `src/config/env.ts` — `loadLlmConfig`: no default model ids, `-latest`/`@latest` refused, key required outside `local`.
- `src/providers/gemini.ts` — the DEC-2 adapter: `x-goog-api-key` header, temperature 0, `responseMimeType: "application/json"` with the JSON schema translated to Gemini's OpenAPI subset (`type: ["string","null"]` → `nullable: true`; nulls dropped from `enum`; nullable fields dropped from `required`), and a retryable-vs-fatal classification (429/5xx retryable; `SAFETY`/`RECITATION`/`MAX_TOKENS` not). It returns TEXT, so `parseAiOutput` remains the only validator.
- `src/ai/stub.ts` — `createScriptedProvider` / `createFixedProvider` for CI and tests: no network, no key, and no `APP_ENV` switch that could select a stub in production.
- Tests: `tests/ai/contract.test.ts` (16), `tests/ai/transport.test.ts` (8), `tests/ai/gemini.test.ts` (11), `src/config/env.test.ts` (+4).

Two defects found by these tests and fixed: the adapter was echoing a provider error body verbatim (a gateway that echoes headers would have leaked the key — now scrubbed from every string that can reach a log), and `loadLlmConfig`'s default base URL still pointed at OpenAI.

Remaining work (not started): `src/ai/answer.ts` — the pipeline itself (classify → policy → fact short-circuit → hybrid retrieval → retrieve-gate → generate → verify → persist `ai_runs` + `citations` in one transaction → emit events) and its DB tests.

Open decisions / blockers:

- **DEC-2 (LLM provider + pinned models).** D12 requires primary + fallback behind an internal interface and per-property model config. The interface, validator and pipeline are calculated; concrete model ids, API keys and any SDK dependency need the decision and explicit dependency approval.
- **PR #32 dependency** for the `lookupFact` short-circuit — contract only.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
