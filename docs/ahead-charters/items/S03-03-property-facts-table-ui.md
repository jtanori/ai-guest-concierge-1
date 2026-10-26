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
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/26
pickup: done
---

# S03-03 — property_facts table + UI

> **CLOSED — implemented, merged and re-verified.** The code landed in PR #32; the review findings listed in §4 were resolved there. §9's last open box (runbook entry + workbook tick) was the only thing outstanding and is closed by the follow-up PR described in §10.

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

- [x] 9 review threads resolved.
- [x] CI green on the fix commit.
- [x] Runbook S03-03 entry + workbook tick (follow-up PR, as done for S03-01/02).
- [x] Issues #26 and epic #27 closed.

## 10. Close-out

**Why this item sat at `☐ Not started` for a month while its code was merged.** The
implementation landed in PR #32 and the runbook entry was written the same day, but
the workbook was never ticked and epic #27 was left open. Every progress report
since then has under-counted S03 by one item and 2.0 days, and the sprint read 2/3
because of a spreadsheet cell, not missing code. This is the failure mode the
close-out checklist exists to prevent, so it is recorded rather than quietly fixed.

**Re-verified on `main` at `9b3f107` (2026-10-26), not taken on trust from the old
entry** — the tree has moved a long way since PR #32 (S04–S07 have landed on top of
this surface):

```text
$ npm run db:migrate   # 20 applied (0009 among them)
$ npm run db:seed      # property_facts: 5, units/effective dates/source version ids filled
$ npm run db:test      # 28 files / 243 passed — includes the 16 fact cases
$ npm test             # 38 files / 500 passed — includes the 11 fact validation cases
$ npm run typecheck && npm run lint   # clean
```

**What the item actually left behind** (the contracts later items depend on):
`lookupFact` (verified-only, exact key, deterministic — no embedding, no provider,
no ranking), `listContradictions` (the pool pair is a real contradiction; the two
spa prices are not), `verifyFact` (actor required, refuses a conflicting verified
row, writes `fact.verified` in the same transaction), `property_facts_verified_key`
(one verified holder per key + effective date) and migration 0009's CHECKs. S04-01
consumes `listContradictions`; S05-01/S05-02 consume `lookupFact`.

**Still open downstream, by other items — not this one:** the fact short-circuit in
the answer path (S05) and the human contradiction-resolution screen (S04-01, shipped
its queue). The two pool facts remain genuinely contradictory in the demo fixture,
which is the point of the adversarial hotel.
