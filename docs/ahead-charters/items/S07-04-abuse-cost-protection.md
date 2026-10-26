---
id: S07-04
title: Abuse + cost protection
sprint: S07
epic: S07 - Chat hardening
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S06-01]
labels: [sprint:S07, track:foundation, prio:P0]
milestone: S07 - Chat hardening
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/82
pickup: done
approved: 2026-10-25
done: 2026-10-25
---

# S07-04 — Abuse + cost protection

| | |
|---|---|
| Sprint | S07 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S06-01 |
| Pickup | `done` |

## 1. Why / goal

Cap trips degrade to 'a team member will reply' without an error.

## 2. Acceptance criteria (backlog AC verbatim)

> Cap trip degrades to 'a team member will reply' without an error.

- **AC-1** Rate limits per IP / conversation / property; Turnstile (or equivalent) on the first message.
- **AC-2** Daily AI spend cap from `spendCaps()`; exceeding it never produces a 5xx.

## 3. Scope

**In:** Rate limiter, bot check, spend accounting, degradation path.

**Out:** Outage fallback (S07-05); PII redaction (S11-03).

## 4. Calculated changes — what was actually built

- **`db/migrations/0019_abuse_and_spend.sql`** (calculated as `0015_abuse.sql`; 0015 is `guest_chat`, so the number rebased on merge order).
  `rate_limits(org_id, property_id, bucket, key, window_start, count)` keyed on the whole tuple, and
  `spend_counters(org_id, property_id, scope, key, cost_usd, calls, updated_at)` with `scope ∈ {day, conversation}`.
  Both FORCE RLS with the `0002` tenant policy, both granted to `concierge_app` including DELETE (they are
  counters with a lifespan, not evidence).
- **`src/security/ratelimit.ts`** — `checkRate(client, context, {ip, conversationId, at})` and the lower-level
  `consume()`. Fixed windows aligned to the epoch; the count comes back from the upsert's `RETURNING`, so two
  concurrent requests cannot both see "19 of 20". Ceilings are **constants in code**, not settings: 20/min per
  hashed IP, 10/min per conversation, 600/hour per property. The IP is stored as `sha256(salt‖ip)` truncated to
  32 hex characters — never an address.
- **`src/security/botcheck.ts`** — the Turnstile port: `loadBotCheckConfig` (disabled in `local` without a secret,
  a **boot failure** in `staging`/`prod` without one) and `verifyBotCheck` over injected `fetch`. Fails closed on
  every vendor problem (unreachable, non-2xx, non-JSON, missing `success`). Applies to the **first message only**,
  because Turnstile tokens are single use.
- **`src/ai/spend.ts`** — `estimateTokens`, `costUsd`, `priceFor`, `loadSpend`, `recordSpend`. Token counts are
  estimated from characters (`ceil(chars / 4)`) because the provider adapters return text, not `usageMetadata`;
  an unknown model is priced at the most expensive known model; the estimate always rounds up. Recording real
  usage is a named follow-up on S07-06.
- **Wiring** — `postGuestMessage` consumes the three buckets and reads the spend snapshot inside the turn
  transaction (so a rolled-back turn charges nothing), then passes `spendTodayUsd` / `conversationSpendUsd` into
  `AnswerDeps`, which `policyGate` already consumed as optional inputs. `answerMessage` calls `recordSpend`
  immediately after a successful generation, before parsing.
- **HTTP** — `RateLimitedError` → **429** with `Retry-After`; `BotCheckFailedError` → **403**; `clientIp` reads the
  first `x-forwarded-for` hop (never a body field).
- **Guest UI** — `web/components/bot-check.tsx` renders the Turnstile widget only when
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set, resets it after each send, and `guest-chat.tsx` turns 429/403 into
  catalogue copy (`guest.chat.rate_limited`, `guest.chat.rate_limited_seconds`, `guest.chat.bot_check`, ES+EN).

## 5. Tenancy & security

Both counters are tenant tables with the standard RLS pair, so one property's spend and flood state are invisible
to the next; `tests/db/isolation.db.test.ts` seeds a row per tenant per table and sweeps both directions. Cross-tenant
inserts are refused. The IP hash is the only client-derived key and is not reversible from the table.

## 6. Test plan — what exists now

- `tests/security/ratelimit.test.ts` (8) — window alignment, hashing stability and opacity, floor ordering of the
  three limits, last-allowed/next-refused, all three buckets consulted with the property bucket consumed even when
  the IP bucket refuses.
- `tests/security/botcheck.test.ts` (13) — config matrix, no vendor call without a token or after the first message,
  form encoding, rejection codes, and failing closed on unreachable / non-2xx / non-JSON / missing `success`.
- `tests/ai/spend.test.ts` (11) — round-up direction, worst-case pricing, monotonicity, UTC day key.
- `tests/guest/http.test.ts` (+2) — 429 with `Retry-After`, 403 for a bot check, `clientIp` hop selection.
- `tests/db/abuse.db.test.ts` (11) — the three buckets counted through a real turn; the 11th message in a minute
  refused **and** nothing written; property-wide flood refused; counters rolled back with a failed turn; cross-tenant
  invisibility; spend accumulation across day + conversation; a real turn charged; the **daily** and **per-conversation**
  cap trips each producing `guest.request_ack` + a `needs_human` request row + an `ai_escalated` event, never a 5xx;
  the bot check refusing and accepting a first message.
- `tests/db/schema.db.test.ts` / `isolation.db.test.ts` / `non-superuser.db.test.ts` extended to 19 migrations and 30 tables.

## 7. Evidence (recorded in the runbook)

`npm test` 34 files / 442 · `npm run db:test` 26 files / 232 · `npx tsc --noEmit` clean · `npm run lint` clean ·
`npm run web:build` green · `npm run db:migrate` 19 applied · `npm run eval` unchanged with the regression gate passing.

## 8. Decisions and deviations from the calculated plan

- **Limits did not go into `PropertySettings`.** The charter put them there; a ceiling a property can raise is not a
  ceiling, and the evening a script runs is exactly the evening someone raises it. They are reviewed constants.
  The *spend* cap stays in settings, because that is the property's own money and `spendCaps()` already reads it.
- **`guest.team_will_reply` was not added.** `guest.request_ack` already says "I've passed this to our team. A person
  will reply here…", and S07-03 routes every non-answer through it. A second key with the same meaning would be two
  copies of one promise. The cap trip reuses S07-03's path unchanged: `policyGate` refuses → `escalate` outcome →
  `requestTopicFor("escalate")` = `needs_human` → `captureRequest`, and the guest sees catalogue copy.
- **Spend is estimated, not metered.** Documented in `src/ai/spend.ts` and flagged below; the transport contract is
  S07-06's and changing it from a cost item would have touched every adapter and test.
- **DEC-9 / W00-18 remains open.** The bot check ships as a port with a no-op in `local`; enabling it in `staging`/`prod`
  requires the vendor to be named in the privacy notice and covered by a DPA. Until then the enforced mode is
  available and tested, and the default is "no third-party processor".
- **Postgres counters, not Redis.** One upsert per guest message is cheaper than the model call it protects, and it
  needs no new runtime dependency (charter approval checklist).

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `web:build` (and `eval` with the regression gate).
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs`.
- [x] Progress report regenerated with `npm run progress` (standing procedure from this item on).
- [x] Cross-tenant isolation suite extended for the two new tables; no new runtime dependency.
- [x] Review threads resolved; §8 decisions recorded in the runbook.

## 10. Follow-ups this item creates

- **S07-06:** record the vendor's real `usageMetadata` instead of estimating tokens, and reconcile
  `spend_counters.cost_usd` against one invoice.
- **S11 (retention):** both counter tables need a retention rule; DELETE is already granted for it.
- **W00-18 / DEC-9:** privacy notice + DPA before the bot check is enabled in production.
- **S11-03:** the ip hash salt should join the rest of the PII handling (rotatable, documented).
