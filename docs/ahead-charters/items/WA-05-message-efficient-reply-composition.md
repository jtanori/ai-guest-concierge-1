---
id: WA-05
title: Message-efficient reply composition
sprint: WA
epic: WhatsApp track (W14-W16)
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S05-02, WA-03]
labels: [sprint:WA, track:foundation, prio:P0]
milestone: WhatsApp track (W14-W16)
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/113
pickup: ready
---

# WA-05 — Message-efficient reply composition

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | WA |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S05-02, WA-03 |
| Pickup | `ready` |

## 1. Why / goal

Fewer, denser messages cut cost and stay readable on WhatsApp.

## 2. Acceptance criteria (backlog AC verbatim)

> One composed message per turn instead of fragmented sends.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (for the coding agent)

- `src/wa/compose.ts`: `composeWhatsApp(answer: AiOutput, lang)` — join the answer + the single most relevant citation into one message ≤1000 chars, strip markdown tables/links-heavy formatting, and append a short `wa.more` catalogue string.
- Add `MAX_WA_BYTES=1000`, `assertWhatsAppLength`, and a truncation path that never cuts a citation mid-sentence (fall back to `guest.idontknow` if it cannot fit).
- Reuse `src/ai/guard.ts` output — no second LLM call. Add `wa.*` strings to `src/i18n/catalog.ts` (ES+EN).

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- `tests/wa/compose.test.ts`: long answer truncates cleanly, citation preserved, no markdown artefacts, ES/EN variants.

## 7. Evidence to record in the runbook

- ``npm test``

## 8. Pickup status, blockers and decisions

**READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge.**

Open decisions / blockers:

- READY — pure composition; depends only on the `AiOutput` type and WA-03's sender.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
