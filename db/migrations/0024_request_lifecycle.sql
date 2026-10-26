-- 0024_request_lifecycle.sql — S09-01 — the request lifecycle, enforced where it
-- cannot be argued with.
--
-- `service_requests.status` has carried the five words new / acknowledged /
-- assigned / resolved / cancelled since 0001, and since then any writer that
-- could reach the row could set any of them. S08-03 tightened two corners (one
-- assignment per person; `acknowledged_at` implies "not new"). This migration
-- closes the rest: the status is a state machine, and the machine lives in the
-- database so that a background job, a retried request, a future endpoint nobody
-- has reviewed yet, and a raw psql session all meet the same rule the UI does.
--
-- The split of responsibilities below is deliberate:
--
--   * TIMESTAMPS AND ACTORS ARE *SHAPE*. "acknowledged_by may not sit on a row
--     that is still new" is a statement about one row in isolation, and it is the
--     same family of rule 0018 already enforces for acknowledged_at/resolved_at —
--     so it reuses 0018's errcode (P0001) rather than inventing a second dialect.
--   * STATUS IS A *TRANSITION*. Whether an edge is legal, and who is allowed to
--     walk it, is a statement about the row's history, and it is what this
--     migration exists to add.
--
-- What is deliberately NOT frozen: once a row is acknowledged, `acknowledged_by`
-- can still be rewritten by an UPDATE that does not touch status. The immutable
-- record of who acknowledged what, and when, is the `audit_log` row written on
-- the edge — same reasoning as S08-04, where `properties` has no `updated_at`
-- because the audit row IS the change record. Freezing the column here would
-- duplicate that record in a place with no history, and would break fixtures
-- that place a row in a state without replaying a staff session to get there.

-- Who acknowledged a request. Added nullable and NOT backfilled: 0023 already
-- established that inventing an acknowledgement timestamp for a pre-existing row
-- would fake the metric it feeds, and inventing an actor would be worse — it
-- would attribute a staff action to nobody, or to the wrong somebody.
ALTER TABLE service_requests
  ADD COLUMN acknowledged_by uuid REFERENCES users(user_id);

COMMENT ON COLUMN service_requests.acknowledged_by IS
  'S09-01: the staff user whose queue-write action moved this request out of new. NULL on rows acknowledged before 0024; never backfilled.';

CREATE FUNCTION request_transition_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor uuid;
BEGIN
  --------------------------------------------------------------------------
  -- INSERT: birth shape only.
  --
  -- A row may be born already-advanced (the S08-01 inbox fixture and 0018's
  -- own "the honest pair is accepted" case both need to place a row in a
  -- state). What it may not do is claim an acknowledging actor while still
  -- claiming to be new — that is the same lie 0018 forbids for
  -- acknowledged_at, told with the new column.
  --------------------------------------------------------------------------
  IF TG_OP = 'INSERT' THEN
    IF NEW.acknowledged_by IS NOT NULL AND NEW.status = 'new' THEN
      RAISE EXCEPTION
        'service_requests: acknowledged_by cannot be set while status is % (db/migrations/0024_request_lifecycle.sql)',
        NEW.status
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  --------------------------------------------------------------------------
  -- UPDATE: identity is not part of what may change.
  --
  -- A trigger that only watched `status` would let an UPDATE move a request to
  -- another property — out of the range of every tenant predicate in the
  -- application, and out of the range of this guard's own membership check on
  -- the way. Watching the whole row closes that without an extra statement
  -- trigger.
  --------------------------------------------------------------------------
  IF (NEW.org_id, NEW.property_id, NEW.request_id) IS DISTINCT FROM
     (OLD.org_id, OLD.property_id, OLD.request_id) THEN
    RAISE EXCEPTION
      'service_requests: (org_id, property_id, request_id) is immutable (db/migrations/0024_request_lifecycle.sql)'
      USING ERRCODE = '23514';
  END IF;

  --------------------------------------------------------------------------
  -- UPDATE: the machine.
  --------------------------------------------------------------------------
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- The only legal edges. Identity is handled by the caller (a no-op), and
    -- nothing may leave a terminal state: `resolved` and `cancelled` are the
    -- end of the row's life, and reopening one would silently invalidate the
    -- resolved_at every SLA number downstream is computed from.
    IF NOT (
         (OLD.status = 'new'          AND NEW.status = 'acknowledged')
      OR (OLD.status = 'acknowledged' AND NEW.status = 'assigned')
      OR (OLD.status = 'assigned'     AND NEW.status IN ('resolved', 'cancelled'))
    ) THEN
      RAISE EXCEPTION
        'service_requests: illegal transition % -> % (db/migrations/0024_request_lifecycle.sql)',
        OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;

    -- Every edge is a staff action, so every edge needs a staff actor. The GUC
    -- is set by withStaffSession (src/auth/context.ts) from a *verified*
    -- provisioned identity, and current_membership_role() is the same definer
    -- function the RLS policies and requireRole() already trust — role_id 1
    -- owner, 2 manager, 3 front_desk hold queue:write; 4 observer does not.
    --
    -- Checking it here rather than only in TypeScript is the whole point of the
    -- item: the acknowledgement has to come from a real queue-write staff
    -- action, and "real" has to mean something to a caller that never went
    -- through the endpoint.
    actor := nullif(current_setting('app.current_user_id', true), '')::uuid;
    IF actor IS NULL
       OR coalesce(current_membership_role(NEW.property_id), 0) NOT IN (1, 2, 3) THEN
      RAISE EXCEPTION
        'service_requests: % -> % requires a queue-write staff actor (db/migrations/0024_request_lifecycle.sql)',
        OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;

    -- The edge has to carry its own evidence, or the state is a claim with
    -- nothing behind it.
    IF NEW.status = 'acknowledged' THEN
      IF NEW.acknowledged_at IS NULL OR NEW.acknowledged_by IS DISTINCT FROM actor THEN
        RAISE EXCEPTION
          'service_requests: acknowledging requires acknowledged_at and the current actor as acknowledged_by (db/migrations/0024_request_lifecycle.sql)'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    -- An assignment row must already exist: the caller inserts it first, in the
    -- same transaction, so that "assigned" cannot be reached without somebody
    -- to assign it to. (0023 keeps that somebody unique per request.)
    IF NEW.status = 'assigned' AND NOT EXISTS (
      SELECT 1 FROM assignments a
       WHERE a.org_id = NEW.org_id
         AND a.property_id = NEW.property_id
         AND a.request_id = NEW.request_id
    ) THEN
      RAISE EXCEPTION
        'service_requests: assigning requires an assignments row (db/migrations/0024_request_lifecycle.sql)'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'resolved' AND NEW.resolved_at IS NULL THEN
      RAISE EXCEPTION
        'service_requests: resolving requires resolved_at (db/migrations/0024_request_lifecycle.sql)'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  --------------------------------------------------------------------------
  -- UPDATE: shape, for the column 0018 has never seen.
  --------------------------------------------------------------------------
  IF NEW.acknowledged_by IS NOT NULL AND NEW.status = 'new' THEN
    RAISE EXCEPTION
      'service_requests: acknowledged_by cannot be set while status is % (db/migrations/0024_request_lifecycle.sql)',
      NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- Same hygiene 0005/0018 apply to the other definer-free guards: the function
-- is invoked by the trigger, not called by tenants.
REVOKE ALL ON FUNCTION request_transition_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS request_transition_guard ON service_requests;
CREATE TRIGGER request_transition_guard
  BEFORE INSERT OR UPDATE ON service_requests
  FOR EACH ROW EXECUTE FUNCTION request_transition_guard();

COMMENT ON TRIGGER request_transition_guard ON service_requests IS
  'S09-01: new -> acknowledged -> assigned -> resolved|cancelled, each edge requiring a queue-write staff actor. Terminal states are terminal.';
