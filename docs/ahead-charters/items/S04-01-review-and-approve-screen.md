---
id: S04-01
title: Review-and-approve screen
sprint: S04
epic: S04 - Retrieval and review
track: Eng
estimate_days: 2.0
priority: P0
depends_on: [S03-01, S03-03]
labels: [sprint:S04, track:foundation, prio:P0]
milestone: S04 - Retrieval and review
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/70
pickup: decision
---

# S04-01 — Review-and-approve screen

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

| | |
|---|---|
| Sprint | S04 |
| Track / days / priority | Eng · 2.0d · P0 |
| Depends on | S03-01, S03-03 |
| Pickup | `decision` |

## 1. Why / goal

First staff surface: human approval gates publication, and contradictory facts cannot be resolved silently. Also discharges deferred S02-06.

## 2. Acceptance criteria (backlog AC verbatim)

> A contradictory pair is blocked until a human resolves it.

- **AC-1** No article version becomes `is_current` without an approval row naming a staff user.
- **AC-2** `listContradictions` groups stay open until a human picks a winner; a resolve that verifies two values is impossible.
- **AC-3** A production caller invokes `requireRole` and a DB-backed denial test proves no write (S02-06).

## 3. Scope

**In:** Approval service + routes, contradiction resolution, role guard wiring, review queue.

**Out:** Browser framework choice (DEC-1); the human resolution UI is owned here but rendering may stay server-rendered.

## 4. Calculated changes (for the coding agent)

- `src/knowledge/review.ts`: `listPendingVersions(client, context)`, `approveVersion(client, context, session, articleVersionId)`, `resolveContradiction(client, context, session, {topicKey, factKey, language, effectiveFrom, winnerFactId})`.
- **Do not add a mutable column to `article_versions`** — 0003's `article_versions_append_only` trigger blocks UPDATEs. Add migration `0010_review_queue.sql` with a separate `article_reviews(org_id, property_id, article_version_id, status CHECK ('pending','approved','rejected'), reviewer_user_id uuid REFERENCES users, decided_at timestamptz, UNIQUE (article_version_id))` + composite FK to `article_versions` (D5 shape) + FORCE RLS + `tenant` policy + `GRANT ... TO concierge_app` (0002 pattern).
- `resolveContradiction` runs in ONE transaction: re-read `listContradictions()` (PR #32), assert the group still exists, `verifyFact(winner)` (sets `verified/verified_by/verified_at`), then `updateFact(loser, ...)` to demote it (any update resets `verified=false`) or write a `fact_resolutions` row. The partial unique index `property_facts_verified_key` is the backstop — never try to verify both.
- Wire S02-06: routes call `withStaffSession(client, context, identity, (session, tx) => { session.requireRole("knowledge","write"); ... })` — `session.requireRole` is already bound in `src/auth/context.ts`. `front_desk`/`observer` must fail before the first query.
- HTTP: `POST /api/review/versions/:id/approve`, `POST /api/review/contradictions/resolve`, `GET /api/review/queue`. Add handlers to the `src/server.ts` route table and matching Vercel `api/review/*.ts` wrappers (same `IncomingMessage`/`ServerResponse` signature as `api/health.ts`). Verify the JWT with `verifyIdentityToken` (`src/auth/session.ts`).
- `src/audit/actions.ts`: add `article.version_approved`, `fact.contradiction_resolved`; add `article_review` and `fact_group` to `ENTITY_TYPES`. Detail = version id / group key only — `assertSafeDetail` rejects body/content keys.
- UI strings go in `src/i18n/catalog.ts` (both `en` and `es` or typecheck fails) — add `staff.review.*` ids.

## 5. Tenancy & security

`article_reviews` and any new table must be added to `tests/db/schema.db.test.ts`'s table list and the `tests/db/isolation.db.test.ts` leak sweep. Guest-facing routes must derive `orgId/propertyId` from the URL slug, never from the request body.

## 6. Test plan (named cases)

- `tests/db/review.db.test.ts`: approval required before publish; contradiction group open until resolve; double-verify refused (23505); cross-tenant version id → not found.
- `tests/db/role-denial.db.test.ts`: owner/manager allowed, front_desk/observer denied, zero writes on denial.
- `tests/knowledge/review.test.ts`: pure group-key + resolution planning.

## 7. Evidence to record in the runbook

- ``npm test``
- ``npm run db:test` (16 facts + review cases)`
- ``npm run typecheck && npm run lint && npm run build``

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

Open decisions / blockers:

- **DEC-1 (UI framework)** — repo has no frontend framework and `docs/charters/README.md` made S03 service-first. Default: server-rendered HTML from `src/server.ts`, zero new dependency; if a framework is chosen it needs explicit dependency approval.
- **Blocked part:** `listContradictions`/`verifyFact` land in PR #32 (S03-03) — this charter states the expected contract; re-check the exact signatures when that PR merges.
- S02-06 (issue #14) is discharged here — budget the extra 1.0d or record the overrun against S04's 5.0d.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
