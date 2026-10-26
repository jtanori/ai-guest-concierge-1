-- 0029_events_hardening.sql — S10-01 — make `events` the analytics source of truth.
--
-- The charter calculated `0022_events_hardening.sql`; 0022–0028 are taken (0022 is
-- citation_quotes, 0028 is the email outbox), so this is 0029 — §4 of the charter
-- says to rebase its numbers on whatever merged first.
--
-- D10's promise is that dashboard numbers reconcile exactly to raw events. Three
-- things stood between the table and that promise, and none of them adds behaviour:
-- each closes a gap between what `events` already claims and what it enforces.

-- 1. Append-only at the PRIVILEGE layer, not only at the trigger.
--
-- 0003 already fires `events_append_only` BEFORE UPDATE OR DELETE, so a rewrite is
-- refused — but only once it reaches the trigger. 0002's
-- `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE` means
-- `concierge_app` still HOLDS both privileges, and a grant nothing uses is a grant
-- something can use: any future code path, psql session or ORM that reaches for an
-- UPDATE gets all the way to the trigger before failing, and what it sees is a
-- domain exception rather than a permission denial.
--
-- This is 0007's exact pattern for `audit_log`, applied to D10's other half. The
-- trigger deliberately stays: it is the backstop for every role that is NOT
-- `concierge_app`, including a superuser, which bypasses privileges but not
-- triggers. Denial now happens at two layers that fail differently — 42501
-- permission denied for the app role, P0001 append-only for everyone else — and
-- `tests/db/events.db.test.ts` asserts both, because a test that only checks the
-- trigger cannot tell you the grant was ever tightened.
REVOKE UPDATE, DELETE ON events FROM concierge_app;

-- 2. payload is a JSON object.
--
-- `emitEvent` already refuses a payload that does not serialize to an object, so
-- every row written through the writer satisfies this. But `events.payload` is
-- reachable by any INSERT the app role can make, and a scalar or array payload
-- breaks every `payload->>'request_id'` read in the reconciliation below and in
-- S10-02's rollups — silently, as a NULL, which reads as "this event has no
-- request" rather than "this event is malformed". The constraint turns a silent
-- NULL into a refused write. Existing rows validate: the column defaults to '{}'.
ALTER TABLE events
  ADD CONSTRAINT events_payload_object CHECK (jsonb_typeof(payload) = 'object');

-- 3. The read the rollups will actually run.
--
-- 0001 gave `events` two indexes: (property_id, created_at DESC) and
-- (event_type, created_at DESC). Neither serves the query S10-02's daily rollups
-- and every per-metric reconciliation makes, which is ONE property, ONE event type,
-- newest first. With the existing pair the planner picks one and filters on the
-- other, so asking a busy property for a week of `ai_answer_sent` scans the week.
--
-- Both 0001 indexes stay, and that is a decision rather than an oversight. The
-- composite puts event_type second, so it cannot serve a property-wide
-- time-ordered scan — that is what `events_property_time` is for — and
-- `events_type` still serves a cross-property per-type read. Three indexes on an
-- append-only table is the cheap side of the trade: nothing here is ever updated,
-- so maintenance is insert-only, and the alternative is a sequential scan on the
-- product's analytics source of truth.
CREATE INDEX events_property_type_time
  ON events (property_id, event_type, created_at DESC);
