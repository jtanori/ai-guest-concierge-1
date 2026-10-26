-- 0023_staff_action_guards.sql — S08-03 — the two constraints the actions assume.
--
-- The staff actions in `src/inbox/actions.ts` are already atomic (they take the
-- conversation's row lock, then re-check the state against the row as it is now).
-- These two constraints are the parts that have to survive a background job, a
-- retried request or a raw psql session — the cases a lock in TypeScript cannot
-- reach.

-- 1. One assignment per (request, person).
--
-- The charter asked for `UNIQUE (org_id, property_id, request_id, assigned_to,
-- created_at)`. That index cannot stop a replay: `created_at` defaults to
-- `now()`, so a retried request inserts a second row with a different timestamp
-- and both look legal. Dropping `created_at` is what makes the guard do the job
-- it was proposed for — "assign to Ana" twice is one assignment. Reassignment to
-- a *different* person is still allowed and still appends, because the history of
-- who held a request is worth keeping.
CREATE UNIQUE INDEX assignments_request_assignee
  ON assignments (org_id, property_id, request_id, assigned_to);

-- 2. Acknowledged means "not new any more".
--
-- `acknowledged_at` was a free-floating timestamp: nothing stopped a row from
-- being `new` and acknowledged at once, which makes "how long until a human
-- acknowledged this?" answerable only by guessing which column to trust. The
-- invariant is one-directional on purpose — the timestamp may be NULL on an old
-- row that was acknowledged before this migration, so it constrains only the
-- impossible combination.
ALTER TABLE service_requests
  ADD CONSTRAINT service_requests_acknowledged_shape
  CHECK (acknowledged_at IS NULL OR status <> 'new');

COMMENT ON CONSTRAINT service_requests_acknowledged_shape ON service_requests IS
  'S08-03: a request cannot be both new and acknowledged. Pre-0023 rows keep their NULL timestamp; nothing is backfilled, because inventing an acknowledgement time would fake the metric it feeds.';

-- 3. A staff takeover is its own reason.
--
-- S08-01's inbox and S08-02's detail view let a human claim a thread that was
-- *not* escalated — a guest said something ambiguous, or an agent just wants to
-- answer personally. Recording that as `guest_asked_human` would corrupt the
-- metric that code feeds (how often guests ask for a person), so the vocabulary
-- grows by one honest word instead. Re-creating the 0017 constraint is the only
-- way to widen a CHECK; every pre-existing row is in the new list, so this
-- validates and tightens rather than relaxes.
ALTER TABLE handoff_reasons DROP CONSTRAINT handoff_reasons_reason_code_check;
ALTER TABLE handoff_reasons
  ADD CONSTRAINT handoff_reasons_reason_code_check
  CHECK (
    reason_code IN (
      'low_retrieval',
      'sensitive_topic',
      'booking_intent',
      'guest_asked_human',
      'policy_block',
      'contradiction',
      'ai_unavailable',
      'staff_takeover'
    )
  );

COMMENT ON CONSTRAINT handoff_reasons_reason_code_check ON handoff_reasons IS
  'Appendix B reason codes + ai_unavailable (S07-02) + staff_takeover (S08-03: a human claimed a thread nobody escalated).';
