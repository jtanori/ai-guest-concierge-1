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
approved: 2026-10-25
---

# S04-01 — Review-and-approve screen

> **APPROVED 2026-10-25, IMPLEMENTED.** DEC-1 was answered by the operator: **React 19 + Next.js + shadcn/ui + Tailwind**, built as a self-contained `web/` app that consumes the `/api/review/*` surface (see §8). The service, the routes and the denial suite are implemented; §9 is checked below.

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

- **AC-1** No article version becomes `is_current` without an approval row naming a staff user. *(Status: MET — `article_reviews` requires reviewer + decided_at for any non-pending status, and `approveVersion` writes the row and the audit entry in the caller's transaction.)*
- **AC-2** `listContradictions` groups stay open until a human picks a winner; a resolve that verifies two values is impossible. *(Status: MET — `resolveContradiction` verifies exactly one winner, `fact_resolutions` keeps the group out of `listContradictions`, and `property_facts_verified_key` refuses a second verified value.)*
- **AC-3** A production caller invokes `requireRole` and a DB-backed denial test proves no write (S02-06). *(Status: MET — `src/knowledge/review.ts` calls `session.requireRole` as its first statement on every function, and `tests/db/role-denial.db.test.ts` counts `article_reviews`, `fact_resolutions`, `audit_log` and verified facts before and after every refusal.)*

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

- **DEC-1 (UI framework) — CLOSED 2026-10-25.** Operator decision: **React 19 + Next.js + shadcn/ui + Tailwind**. Implemented as a separate app in `web/` (own `package.json`, built with `npm run web:build`) rather than by migrating `src/server.ts`: the existing server keeps serving the JSON API and the Vercel `api/` functions, and the screen talks to it through one proxy route (`web/app/api/review/[...path]/route.ts`). Business logic therefore exists exactly once, and a role that cannot write in `tests/db/role-denial.db.test.ts` cannot write from the screen either. shadcn/ui components are vendored source (`web/components/ui/*`) as shadcn intends; the copy comes from `src/i18n/catalog.ts`, imported — not duplicated — so D14 holds for the new app too. Approved dependency set: `next`, `react`, `react-dom`, `tailwindcss` + `@tailwindcss/postcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `@radix-ui/react-slot`, `@radix-ui/react-label`.
- **Unblocked:** `listContradictions`/`verifyFact` merged in PR #32 (S03-03); signatures confirmed against the merged code.
- S02-06 (issue #14) is discharged here; the extra 1.0d is recorded against S04 (2.0d + 1.0d).

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test` (277), `db-test` (137), `web build` (and `eval` once S06-03 lands).
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` after the AC is objectively met.
- [x] Cross-tenant isolation suite extended for both new tables; the only new dependencies are the DEC-1 set approved by the operator.
- [x] Review threads resolved; the DEC-1 decision is recorded here and in the runbook.
