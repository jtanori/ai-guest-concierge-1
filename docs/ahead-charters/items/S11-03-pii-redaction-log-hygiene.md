---
id: S11-03
title: PII redaction + log hygiene
sprint: S11
epic: S11 - Reliability
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S10-01, W00-18]
labels: [sprint:S11, track:foundation, prio:P0]
milestone: S11 - Reliability
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/99
pickup: decision
---

# S11-03 — PII redaction + log hygiene

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S11 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S10-01, W00-18 |
| Pickup | `decision` |

## 1. Why / goal

A synthetic card number never reaches logs (plan §5).

## 2. Acceptance criteria (backlog AC verbatim)

> A synthetic card number never reaches logs.

- **AC-1** Luhn-valid card-like input is detected, refused in chat and never logged.
- **AC-2** 90-day default retention for `messages.body` with a documented deletion path.
- **AC-3** Log/test fixtures contain no real PII.

## 3. Scope

**In:** Redaction layer, card detector, retention job, log assertions.

**Out:** Legal text (W00-18); payment processing (out of scope entirely).

## 4. Calculated changes (for the coding agent)

- `src/security/pii.ts`: `containsCardLike(text)` (digit-run 13–19 + Luhn), `maskPii(value)` for emails/phones/cards — share `containsCardLike` with `src/ai/banned.ts` (S05-02).
- `src/logging/redact.ts`: a pino `redact`-style path applied in `createLogger` (`src/logging/index.ts`) and in `reportError`; add a `serialize()` hook that masks any string field including `body`, `question`, `answer`, `payload`, `detail` before writing.
- `scripts/retention.ts`: delete/anonymise `messages.body` older than `settings.retention_days` (default 90, add to `src/settings/schema.ts::DEFAULT_SETTINGS`); keep `events`/`rollups` aggregates (they must contain no message text); log counts, never bodies. Add `"retention"` script + a nightly workflow.
- Migration `0025_retention.sql`: add `body_redacted_at timestamptz` to `messages` and a partial index for the retention scan; `ALTER TABLE events` add a CHECK that `payload` has no `body`/`card`/`message_text` keys (use a trigger or `assertSafeDetail`-style check in the writer).

## 5. Tenancy & security

Retention job iterates properties and sets GUCs per property; a redaction failure in one tenant must not abort others.

## 6. Test plan (named cases)

- `tests/logging/redaction.test.ts`: synthetic Luhn card, email, phone in every log shape → masked; `reportError` payload masked.
- `tests/db/retention.db.test.ts`: 91-day message redacted, 89-day untouched, events unaffected, two properties isolated.

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``
- `CI grep of logs for the synthetic card string (must be 0 hits)`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-9 / W00-18:** retention window, vendor list and the cross-border data-flow map are legal decisions. Code is calculated; the default 90 days must be confirmed by counsel.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
