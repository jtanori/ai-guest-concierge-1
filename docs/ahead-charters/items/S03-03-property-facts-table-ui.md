---
id: S03-03
title: property_facts table + UI
sprint: S03
epic: S03 - Knowledge
track: Eng
estimate_days: 2.0
priority: P0
depends_on: [S03-01]
labels: [sprint:S03, track:foundation, prio:P0]
milestone: S03 - Knowledge
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/26
pickup: inflight
---

# S03-03 — property_facts table + UI

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S03 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S03-01 |
| Pickup | `inflight` |

## 1. Why / goal

Deterministic verified-fact lookup — the sprint gate AC. Already implemented; the open PR carries 9 review findings.

## 2. Acceptance criteria (backlog AC verbatim)

> Pool hours answered by lookup, not generation.



## 3. Scope

**In:** This item only.

**Out:** Anything listed against a different backlog ID.

## 4. Calculated changes (skip — implementation is in PR #32 at `81b19bb`)

- **No new calculations here.** The other agent is fixing review `5642937269`: [P1] DB-level enforcement of `verified` (column-level `REVOKE UPDATE` + `SECURITY DEFINER` verifier / `BEFORE UPDATE` trigger on 0009), [P2] `NOT VALID` CHECK or pre-flight guard for legacy verified rows, [P2] `updateFact` clearing `source_article_version_id` on `undefined`, [P2] `verifyFact` auditing stale pre-lock values, [P2] `CURRENT_DATE` vs `properties.time_zone`, [P2] actor/session binding, [P3] re-verify idempotency, [P3] partial `verified` lookup index, [P3] charter §5.1 drift.
- Downstream contracts this PR must freeze before S04/S05 can be calculated exactly: `lookupFact(client, context, {topicKey, factKey, language, on?})`, `listContradictions(client, context)`, `verifyFact(...)`, and the `property_facts_verified_key` partial unique index.

## 5. Tenancy & security

All reads/writes through `withTenant` / `withStaffSession`; new tables must be enumerated in `tests/db/schema.db.test.ts` and `tests/db/isolation.db.test.ts` with FORCE RLS + a `tenant` policy (0002 pattern).

## 6. Test plan (named cases)

- _Covered by the sprint's existing suite._

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**IN FLIGHT — already implemented in an open PR; no new calculations, only the review findings to fix.**

Open decisions / blockers:

- Blocks exact calculations for S04-01 (contradiction resolution) and S05-01/02 (fact short-circuit). Their charters state the expected contract and mark that part deferred.

## 9. Definition of done

- [ ] 9 review threads resolved.
- [ ] CI green on the fix commit.
- [ ] Runbook S03-03 entry + workbook tick (follow-up PR, as done for S03-01/02).
- [ ] Issues #26 and epic #27 closed.
