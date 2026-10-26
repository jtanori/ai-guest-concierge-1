-- 0018_request_capture.sql — S07-03 — a request cannot lie about itself.
--
-- Two constraints, both about the same failure: a row that *looks* handled when
-- nothing has happened to it yet.
--
-- 1. `service_requests.acknowledged_at` / `resolved_at` may only be set
--    alongside the status they belong to. Before this, a writer could stamp
--    `acknowledged_at` on a `status='new'` row and any later "was it picked
--    up?" query would say yes. The staff action that legitimately sets these is
--    S09-01's; the guard here means S09-01 cannot be built on a table that
--    allowed the claim in the meantime.
--
--    `acknowledged_at` is deliberately NOT required when `status` moves to
--    'acknowledged': that rule belongs to the lifecycle transition (S09-01),
--    which also knows who did it. This migration only forbids the impossible
--    pairings, so it cannot conflict with the transition table 0018 does not
--    own.
--
-- 2. `knowledge_gaps` is where "we do not have an answer for this" is recorded,
--    and S07-03 makes it the thing a captured request points at. The partial
--    index makes the dedupe lookup (`is there already an open gap for this
--    question in this conversation?`) cheap; without it, `captureRequest` would
--    scan the property's whole gap history on every unanswered turn.

CREATE OR REPLACE FUNCTION service_requests_time_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.acknowledged_at IS NOT NULL AND NEW.status = 'new' THEN
    RAISE EXCEPTION
      'service_requests: acknowledged_at cannot be set while status is % (db/migrations/0018_request_capture.sql)',
      NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.resolved_at IS NOT NULL AND NEW.status <> 'resolved' THEN
    RAISE EXCEPTION
      'service_requests: resolved_at may only be set when status is resolved, not % (db/migrations/0018_request_capture.sql)',
      NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_requests_time_guard ON service_requests;
CREATE TRIGGER service_requests_time_guard
  BEFORE INSERT OR UPDATE OF status, acknowledged_at, resolved_at ON service_requests
  FOR EACH ROW
  EXECUTE FUNCTION service_requests_time_guard();

COMMENT ON TRIGGER service_requests_time_guard ON service_requests IS
  'S07-03: a request may not claim to have been acknowledged or resolved before its status says so.';

CREATE INDEX knowledge_gaps_open_by_conversation
  ON knowledge_gaps (org_id, property_id, conversation_id)
  WHERE status = 'open';
