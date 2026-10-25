---
id: DF-01
title: Outbound webhook per property
sprint: DF
epic: Deferred to MVP-1.5
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S09-05]
labels: [sprint:DF, track:foundation, prio:P0]
milestone: Deferred to MVP-1.5
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/117
pickup: deferred
---

# DF-01 — Outbound webhook per property

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | DF |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S09-05 |
| Pickup | `deferred` |

## 1. Why / goal

Signed, retried events to a hotel's own tools (Teams/Slack/etc.).

## 2. Acceptance criteria (backlog AC verbatim)

> A signed outbound webhook is delivered and retried.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (skipped — deferred to MVP-1.5)

- **Skipped by instruction.** Backlog §Deferred says this returns when a group needs events piped into their own tools. When it returns: add `property_webhooks(org_id, property_id, url, secret, events[], active)` with FORCE RLS, sign payloads with HMAC-SHA256, deliver via `outbox(kind='webhook')` (S11-01) and emit `outbound_webhook_delivered` (already in the 18-event taxonomy).
- Note: `events.event_type` already includes `outbound_webhook_delivered`, so no schema change to the taxonomy is needed.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**DEFERRED — explicitly out of MVP; no changes calculated (per user instruction to skip where not possible).**

Open decisions / blockers:

- Deferred — no changes calculated.

## 9. Definition of done

- [ ] _Deferred. Re-open only when the trigger condition in `docs/07-master-backlog.md` §Deferred is met._
