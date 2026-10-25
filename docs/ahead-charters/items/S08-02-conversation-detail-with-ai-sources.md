---
id: S08-02
title: Conversation detail with AI sources
sprint: S08
epic: S08 - Staff inbox
track: Eng
estimate_days: 1.0
priority: P0
depends_on: [S08-01, S05-03]
labels: [sprint:S08, track:foundation, prio:P0]
milestone: S08 - Staff inbox
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/86
pickup: decision
---

# S08-02 — Conversation detail with AI sources

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S08 |
| Track / days / priority | Eng · 1.0d · P0 |
| Depends on | S08-01, S05-03 |
| Pickup | `decision` |

## 1. Why / goal

Staff can see the cited text verbatim (D5 makes this possible).

## 2. Acceptance criteria (backlog AC verbatim)

> Staff can see the cited text verbatim.

- **AC-1** The detail view shows each AI message's citations with the exact `article_version` body/quote that was used.
- **AC-2** Editing the article later does not change what the staff member sees for an old answer.

## 3. Scope

**In:** Detail query + view + 'wrong or outdated' affordance hook (S09-03).

**Out:** Flagging persistence (S09-03); reply actions (S08-03).

## 4. Calculated changes (for the coding agent)

- `src/inbox/detail.ts`: `getConversationDetail(client, context, conversationId)` → `messages` + for each AI message the `ai_runs` row + `citations` joined to `article_versions.body` on the composite `(org_id, property_id, article_version_id)` — reuse `src/ai/history.ts::reconstructAnswer` from S05-03 rather than writing a second join.
- Show `model_id`, `prompt_version`, `decision`, `reason_code` and the exact quote; escape HTML (server-rendered default) to avoid stored XSS from guest messages.
- Add a `data-ai-run-id` attribute to each AI message block for S09-03's one-click flag.

## 5. Tenancy & security

Detail query must check `conversation_id` belongs to the context; foreign id → 404 (no existence leak).

## 6. Test plan (named cases)

- `tests/db/inbox-detail.db.test.ts`: cited text verbatim, survives a later article edit, foreign conversation 404, HTML-escaped guest body.

## 7. Evidence to record in the runbook

- ``npm run db:test``
- `screenshot of the sources pane in runbook`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-1 (UI rendering).** Query + escaping are calculated. Depends on S05-03's reconstruction function.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
