# Limited approval: independent implementation packages

Owner authorization: explicitly requested in the Arena conversation on 2026-10-25.
Status: **Approved by owner for the scope below; effective only after this documentation PR merges.**

This is a limited exception to sprint-by-sprint chartering, not approval of either
full parent story or of the remaining draft charter collection. No parent AC is
weakened. Do not close #71 or #94, or tick their workbook rows, on completion of
these packages. The GitHub parent stories may retain their draft labels.

## S04-02-A — Pure deterministic chunker

Parent: [S04-02 / #71](https://github.com/jtanori/ai-guest-concierge-1/issues/71).

### Approved calculated changes

- Add `src/knowledge/chunk.ts`, without imports from the database, fact service,
  provider adapters, configuration or publication service.
- Export `chunkBody(body: string, opts?: { maxChars?: number; overlap?: number }): string[]`.
  Defaults: `maxChars=1200`, `overlap=150`. Reject noninteger values,
  `maxChars < 1`, `maxChars > 2000`, `overlap < 0`, or `overlap >= maxChars`.
- Empty/whitespace-only body returns `[]`. Normalize CRLF to LF. Prefer paragraph
  and then sentence boundaries; split oversized unbroken input at Unicode code
  point boundaries as the final fallback. Never discard text. Count limits in
  Unicode code points. Prefer whole-sentence overlap within the overlap budget;
  use zero overlap if no complete sentence fits. Always advance through input.
- Output must be deterministic, nonempty per chunk, and within `maxChars`.
  Publication refusal for zero chunks belongs to later integration, not this module.
- Add `tests/knowledge/chunking.test.ts`: empty input, CRLF, short input,
  3,000-word text, overlap, oversized sentence, unbroken text, emoji/surrogate
  boundaries, invalid options, and exact repeated-output determinism. Prove no
  source text is lost at splitting boundaries after accounting for overlap.

### Excluded / still blocked

No migrations, provider/API keys, embeddings, publication integration, fixtures,
seed changes, database tests, package dependencies or changes to existing modules.
DEC-3 and the full S04-02 publication AC remain open.

## S10-01-A — Tenant-scoped event writer

Parent: [S10-01 / #94](https://github.com/jtanori/ai-guest-concierge-1/issues/94).

### Approved calculated changes

- Add `src/events/emit.ts`; consume the existing `EventName`, `EventContext`,
  `isEventName` and `createEvent` from `src/events/taxonomy.ts`. Do not alter the
  taxonomy, its 18 event names, or its existing tests.
- Export `emitEvent(client, tenantContext, type, eventContext, data)` using the
  repository's existing pg client and TenantContext types. Validate runtime
  event names and context through the existing taxonomy functions. Require the
  event's org/property to equal the transaction's tenant context before SQL.
- Map the validated event into the existing `events` columns using one
  parameterized INSERT. Inspect the current merged schema for exact column
  names; do not assume an `Event.data` field is a database column of that name.
- The caller owns the tenant transaction. Do not BEGIN/COMMIT, acquire another
  connection, call a provider, or emit outside that transaction. Return the
  inserted event identifier; propagate insertion errors for caller rollback.
- Add `tests/events/emit.test.ts` with a fake pg client: parameter binding,
  field mapping, nullable language/topic, invalid event name/context and tenant
  mismatch rejected before SQL, propagated DB errors, and no transaction-control
  statements. No raw payload logging.

### Excluded / still blocked

No migrations, grants, taxonomy changes, business-path instrumentation,
reconciliation, rollups, production wiring, shared DB-test inventories or new
runtime dependencies. These tests prove the writer boundary only, not database
isolation or full S10-01 acceptance. Production integration still needs real
DB/RLS/rollback tests and the upstream S04–S09 call sites.

## Parallel execution and completion rules

- Start from current merged `main`, not the old Arena session base. This session's
  implementation branch remains fixed; downstream agents use their own assigned
  workspaces. Recheck open PR file lists before starting.
- Each package owns only its two new files listed above. Do not edit PR #32's
  fact service, migration, audit registry, fixtures, seed, ERD or DB tests.
- Do not edit `docs/runbook.md`, package manifests, CI, workbook or migration
  numbering in these implementation packages. Put evidence in the implementation
  PR body; consolidate runbook evidence after parallel work has merged.
- Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` with the
  repository-required Node version. Record actual commands, counts and failures.
- Implementation PR titles: `S04-02-A: pure chunker` and
  `S10-01-A: tenant-scoped event writer`. Use **Refs #71** / **Refs #94**, not
  `Closes`. Review and merge each independently.
- Reconcile this approval into the parent charters before full-story approval.
  All other draft charters remain unapproved. W00 evidence audits are not part
  of this approval.
