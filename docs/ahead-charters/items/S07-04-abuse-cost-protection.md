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
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/82
pickup: decision
---

# S07-04 — Abuse + cost protection

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S07 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S06-01 |
| Pickup | `decision` |

## 1. Why / goal

Cap trips degrade to 'a team member will reply' without an error.

## 2. Acceptance criteria (backlog AC verbatim)

> Cap trip degrades to 'a team member will reply' without an error.

- **AC-1** Rate limits per IP / conversation / property; Turnstile (or equivalent) on the first message.
- **AC-2** Daily AI spend cap from `spendCaps()`; exceeding it never produces a 5xx.

## 3. Scope

**In:** Rate limiter, bot check, spend accounting, degradation path.

**Out:** Outage fallback (S07-05); PII redaction (S11-03).

## 4. Calculated changes (for the coding agent)

- `src/security/ratelimit.ts`: `checkRate(client, context, {ip, conversationId})` with a fixed-window counter table `rate_limits(org_id, property_id, bucket, key, count, window_start, PRIMARY KEY (...))` (migration `0015_abuse.sql`) + FORCE RLS; limits from `PropertySettings` (`spend_cap`, add `rate_limits` defaults in `src/settings/schema.ts`).
- `src/security/botcheck.ts`: Turnstile verify via `fetch` with `TURNSTILE_SECRET` in `src/config/env.ts`; on unverifiable/absent token in `local`, allow but log. **Decision needed**: Turnstile is a third-party vendor — W00-18's privacy notice must list it.
- `src/ai/spend.ts`: `recordSpend(client, context, {conversationId, costUsd})` accumulating against `spendCaps(settings).dailyUsd` and `perConversationUsd`; `answerMessage` checks before generation and, on cap trip, returns `t('guest.team_will_reply')` + `captureRequest` (S07-03) — same honest-degradation path as S07-05.
- Add `guest.team_will_reply` to `src/i18n/catalog.ts` (ES+EN).

## 5. Tenancy & security

Spend counters are per property; a noisy tenant must not starve another — key every counter by `(org_id, property_id)`.

## 6. Test plan (named cases)

- `tests/security/ratelimit.test.ts`: burst over limit → degrade (not 500); counter resets on window change.
- `tests/ai/spend.test.ts`: cap trip → no provider call → honest reply + request row.
- `tests/db/abuse.db.test.ts`: two properties have independent budgets.

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``
- `CI log of a simulated cap trip`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-9 / W00-18:** a bot-check vendor is a third-party data processor and must appear in the privacy notice + DPA. Default: implement the port with a no-op verifier in `local` and require the secret in `staging`/`prod`.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
