---
id: S02-03
title: Audit log
sprint: S02
epic: S02 — Identity, settings, audit
track: Foundation
estimate_days: 1.0
priority: P0
depends_on: [S01-01, S02-02]
labels: [sprint:S02, track:foundation, prio:P0]
milestone: S02 — Identity, settings, audit
---

# S02-03 — Audit log

## 1. Why

The backlog AC is "Every consequential action writes an audit row". The plan
(§5 Security) makes two promises procurement will test: *who changed an
answer, took over, sent* and *any platform-admin impersonation is logged and
visible to the hotel*. `audit_log` already exists (0001), is tenant-scoped
(0002) and append-only (0003 trigger blocks UPDATE/DELETE), but nothing writes
to it and nothing reads it. `concierge_app` still holds UPDATE/DELETE grants
on the table — the trigger refuses them, but least privilege should not rely
on a trigger.

## 2. Goal

One write path, one closed vocabulary, one read path, and the first real call
site wired (settings changes from S02-02) — inside the same transaction as the
mutation, so an audit failure rolls the mutation back. Support-access logging
gets a helper now; the platform-admin route that calls it arrives with the
platform surface (S10).

## 3. Acceptance criteria

**Backlog AC (verbatim):** Every consequential action writes an audit row.

- **AC-1** A consequential mutation and its audit row commit or roll back
  together: settings update + `settings.updated` row is the wired proof.
- **AC-2** The row identifies actor, tenant, action, entity and a
  JSON `detail` that is safe to retain: `actor_user_id` = the authenticated
  staff user, `org_id`/`property_id` = the addressed tenant.
- **AC-3** The action vocabulary is closed in code: unknown actions/entity
  types and unsafe detail keys are rejected before SQL runs.
- **AC-4** Staff of a property can list that property's audit rows; another
  property's rows are invisible; UPDATE/DELETE are impossible for the app
  role (trigger + revoked grants).
- **AC-5** Support access is expressible now: `writeSupportAccess` records
  operator identity, reason and ticket against the property. The
  platform-admin authorization path is out of scope but the row shape is
  fixed and tested.
- **AC-6** The audit surface is explicit in the S02-01 matrix: `audit` read
  for all four roles, no write for anyone (writes only via server helpers).

## 4. Scope

**In:** `src/audit/actions.ts`, `src/audit/write.ts`, `src/audit/read.ts`,
`src/audit/support.ts`; guard matrix amendment (`audit` surface); migration
`0007_audit_privileges.sql`; wiring into `src/settings/store.ts`; unit tests;
`tests/db/audit.db.test.ts`.

**Out:** audit UI/reporting (S04+); retention/archival of audit rows (no
retention requirement stated); partitioning; platform-admin auth and the
impersonation route (S10); audit of seed runs (seeding is not a staff action);
audit of every future action — each item adds its call site when it lands
(the vocabulary and helper are the contract).

The backlog dependency is `S01-01` only; this item additionally consumes
S02-02's `changed` list for the one wired call site, so it is sequenced after
S02-02 in the same sprint.

## 5. Design

### 5.1 Vocabulary (`src/audit/actions.ts`)

```ts
export const AUDIT_ACTIONS = [
  "settings.updated",
  "membership.granted", "membership.role_changed", "membership.revoked",
  "article.version_published", "article.archived",
  "fact.verified",
  "conversation.takeover", "message.sent",
  "support.access",
] as const;
export const ENTITY_TYPES = [
  "property","membership","user","article","article_version","fact",
  "conversation","message",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type EntityType = (typeof ENTITY_TYPES)[number];
export function isAuditAction(v: string): v is AuditAction;
export function isEntityType(v: string): v is EntityType;
```

Adding an action is a code change with a test, not a free-form string. The DB
keeps `action text` (no CHECK on the vocabulary) so the app can evolve without
a migration; the TS union is the gate.

### 5.2 Write path (`src/audit/write.ts`)

```ts
export interface AuditEntry {
  orgId: string; propertyId: string;
  actorUserId: string | null;            // null only for system events
  action: AuditAction;
  entityType: EntityType;
  entityId: string;
  detail?: Record<string, unknown>;
}
export class AuditWriteError extends Error {}
export async function writeAudit(client: pg.Client, entry: AuditEntry): Promise<bigint>;
```

- Validates action/entity types, UUIDs, non-empty `entityId`, and `detail`
  safety: reject top-level keys matching
  `/body|message_body|content|card|pan|token|secret|password/i` (plan §5/S11-03:
  no message bodies in third-party stores; same hygiene here). Values must be
  JSON-serializable primitives/arrays/objects (reject `undefined`, functions,
  circular).
- Single `INSERT INTO audit_log (...) VALUES (...) RETURNING audit_id`; no
  SECURITY DEFINER — the caller's tenant GUCs + `tenant` policy do the
  scoping, and `actor_user_id` must reference an existing user or be null.
- **Must be called inside the caller's transaction** (signature takes the
  client, not a pool); a failed insert aborts the mutation.

### 5.3 Read path (`src/audit/read.ts`)

```ts
export interface AuditRow { auditId: string; actorUserId: string | null;
  action: string; entityType: string; entityId: string;
  detail: Record<string, unknown>; createdAt: Date }
export async function listAudit(client, ctx: {orgId; propertyId},
  opts?: { limit?: number; beforeId?: string }): Promise<AuditRow[]>;
```

`ORDER BY audit_id DESC`, `limit` clamped 1..200 (default 50), `beforeId`
exclusive cursor. RLS scopes to the tenant; no action filtering in v1 (the
surface is small). All four roles may read (see §5.5) — the plan's "visible to
the hotel" is taken literally: observers included.

### 5.4 Support access (`src/audit/support.ts`)

```ts
export async function writeSupportAccess(client, ctx: {orgId; propertyId}, input: {
  actorUserId: string; operatorEmail: string; reason: string; ticket?: string;
}): Promise<bigint>;
```

Writes `support.access` with `entityType: "property"`,
`entityId: propertyId`, detail `{ operator_email, reason, ticket }`. Reason
required, non-empty. The authorization decision (is this actor a platform
admin?) is explicitly **not** here; when S10 adds the route it must call this
helper before granting any cross-tenant read.

### 5.5 Guard matrix amendment

Add `audit` to `Surface` and `MATRIX`: owner/manager/front_desk/observer all
`["read"]`, nobody `["write"]`. Update the exhaustive matrix test and any
surface-count assertions. Rationale: audit is an oversight surface; writing is
not a staff capability. (This is the only S02-01 file touched.)

### 5.6 Wiring and migration

- `savePropertySettings` (S02-02) gains an `actor` argument
  (`{ userId: string }`) and calls `writeAudit` with
  `action: "settings.updated"`, `entityType: "property"`,
  `entityId: propertyId`, `detail: { changed }` in the same transaction.
  Signature change is part of this item; S02-02 tests are updated.
- Migration `0007_audit_privileges.sql`:
  `REVOKE UPDATE, DELETE ON audit_log FROM concierge_app;` (SELECT/INSERT and
  the sequence remain). No other schema change.

## 6. Tenancy and security

- Tenant scoping: RLS `tenant` policy (0002) on `audit_log`; `property_id`
  and `org_id` are NOT NULL, so there is no org-wide row today.
- Append-only: 0003 trigger raises on UPDATE/DELETE for every role, and 0007
  removes the app's grants as defense in depth.
- PII: `detail` must never carry guest message bodies or payment-like data;
  the key guard is enforced in code and tested. Actor identity is a user UUID,
  not an email (except the explicit support-access operator email, which the
  plan requires).
- No secrets in `detail`; the guard rejects token/secret/password keys.

## 7. Test plan

Unit — `tests/audit/actions.test.ts`, `tests/audit/detail.test.ts`:
- every vocabulary entry passes `isAuditAction`; unknown strings fail.
- detail guard: rejects `body`, `message_body`, `content`, `card_number`,
  `token`, `secret`, `password` (nested one level too); accepts `{changed:
  ["tone"]}`; rejects undefined/function/circular values.

DB — `tests/db/audit.db.test.ts`:
- `savePropertySettings` under a staff session writes exactly one
  `settings.updated` row: actor = caller, entity = property, detail.changed
  correct; the settings row and the audit row are both visible after commit.
- rollback proof: force `writeAudit` to fail (unknown action via cast or an
  unsafe detail) → settings value unchanged and no audit row.
- `listAudit` returns newest first, honours `limit`/`beforeId`; property-B
  staff see zero of property-A rows; observer can list.
- direct `UPDATE audit_log …` and `DELETE FROM audit_log …` as
  `concierge_app` fail (trigger; grants revoked).
- `writeSupportAccess` writes the row with operator email/reason/ticket.
- guard matrix includes `audit` read for all roles and no write.

## 8. Evidence

```text
$ npm run db:migrate -- --url .../concierge_local      # 7 applied (0007 lands)
$ npm run db:test                                      # audit + settings suites pass
$ npm test                                             # unit incl. vocabulary/detail guards
$ npm run typecheck && npm run lint && npm run build   # clean
```

Runbook S02-03 entry lists the wired call site (settings) and states the
call-site rule for future items.

## 9. Risks and open questions

- **"Every consequential action"** is only demonstrable for actions that exist.
  This item wires settings and fixes the vocabulary; membership/article/
  conversation call sites land with their own items. The PR must say this
  explicitly so the AC is not read as "all future actions are already
  audited".
- **Actor for system actions** is `NULL` (`actor_user_id` is nullable). Seed
  and background jobs use it; the UI should render "system".
- **Support access enforcement** is deferred to S10. Until then the helper is
  the only way to express it, and no route can impersonate.
- **Audit retention** is unbounded. Not required by the plan; revisit if
  storage becomes an issue.
- **Detail schema drift**: `detail` is free-form JSON by design; the action
  vocabulary is closed but detail keys are not. Keep per-action keys
  documented in this charter when call sites are added.

## 10. Definition of done

- [ ] `0007` applies; app role can no longer UPDATE/DELETE `audit_log`.
- [ ] Guard matrix extended and exhaustively tested.
- [ ] Settings update + audit are atomic; rollback test passes.
- [ ] Vocabulary and detail guards tested; no new dependency.
- [ ] Runbook entry with AC, wired call sites, evidence numbers.
- [ ] Workbook tick via workbook PR after merge; review threads resolved.
