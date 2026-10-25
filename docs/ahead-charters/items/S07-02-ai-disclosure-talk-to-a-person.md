---
id: S07-02
title: AI disclosure + 'talk to a person'
sprint: S07
epic: S07 - Chat hardening
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S06-02]
labels: [sprint:S07, track:foundation, prio:P0]
milestone: S07 - Chat hardening
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/80
pickup: decision
---

# S07-02 — AI disclosure + 'talk to a person'

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S07 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S06-02 |
| Pickup | `decision` |

## 1. Why / goal

Legal/ethical baseline: guests know it's AI and can reach a human in one tap from any state.

## 2. Acceptance criteria (backlog AC verbatim)

> A human is reachable in one tap from any state.

- **AC-1** First AI reply contains `guest.ai_disclosure` (ES+EN from the catalogue).
- **AC-2** One tap posts a handoff that works from `idle`, `awaiting_ai`, `awaiting_staff` and `resolved`.

## 3. Scope

**In:** Disclosure copy, handoff button/route, handoff state transition.

**Out:** Staff inbox rendering (S08-01); notification delivery (S09-05).

## 4. Calculated changes (for the coding agent)

- Use the existing `t('guest.ai_disclosure', lang)` and `t('guest.talk_to_person', lang)` from `src/i18n/catalog.ts` — **no new copy outside the catalogue** (D14).
- `POST /api/chat/handoff`: call `transition(..., 'awaiting_staff')` from `src/conversation/state.ts`, insert a `handoff_reasons` row with `reason_code='guest_asked_human'`, emit `human_takeover`, create a `service_requests` row so S09-05 can notify even with no staff view.
- Render the button in the guest widget from S06-01; pressing it must succeed even if the AI provider is down (no provider call in this path).

## 5. Tenancy & security

Handoff writes use the guest-derived tenant context; `reason_code` is a closed enum — add a CHECK alongside the migration in S06-02 if not already present.

## 6. Test plan (named cases)

- `tests/db/handoff.db.test.ts`: handoff from all four states; no provider call; `human_takeover` + `request_created` events; disclosure present on first AI message in ES and EN.

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test``

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-1 (UI rendering).** Copy, route, DB writes and states are fully calculated — only the widget markup waits on the framework choice.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
