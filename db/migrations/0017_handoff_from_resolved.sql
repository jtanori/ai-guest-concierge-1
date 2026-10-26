-- 0017_handoff_from_resolved.sql — S07-02 — a human is reachable from any state.
--
-- Two changes, both consequences of AC-2 ("one tap posts a handoff that works
-- from `idle`, `awaiting_ai`, `awaiting_staff` and `resolved`") meeting what
-- 0016 actually allowed.
--
-- ## 1. `resolved -> awaiting_staff` becomes legal
--
-- 0016 deliberately refused it, on the grounds that resolving is a conclusion
-- and escalating afterwards would discard it. S07-02's AC is the better rule,
-- and this migration says so rather than routing around it:
--
--   * The state the guest can see is "this thread is done". If they then tap
--     "talk to a person", refusing the handoff because the row says `resolved`
--     means the one control that exists to protect them stops working exactly
--     when the bot has already given up.
--   * Nothing is discarded. `conversations.status` still carries open/closed,
--     the transcript is untouched, and `handoff_reasons` gains the reason the
--     reopening happened. `ai_state` was never the audit log; the events are.
--
-- The alternative — routing through `awaiting_ai` to reach `awaiting_staff` —
-- would claim a model is answering when none was asked, and would put an
-- artificial transition in the audit trail. Two legal edges are honest; a lie in
-- the state column is not.
--
-- `resolved -> idle` stays illegal: nothing about a guest asking for a human
-- returns a concluded thread to "the bot may answer", and this change must not
-- quietly widen that.
--
-- ## 2. `handoff_reasons.reason_code` becomes a closed vocabulary
--
-- S05-02's rule for `ai_runs.reason_code` applies here too: a code nobody can
-- alert on is a code nobody will read. The list is Appendix B plus
-- `ai_unavailable` (the outage path already records it), and it is `NOT VALID`
-- on purpose — it constrains every new write immediately while tolerating rows
-- written before the vocabulary existed, so this migration cannot fail on data
-- it did not create. Extending the list is a deliberate one-line migration, not
-- a free-text field.

CREATE OR REPLACE FUNCTION conversations_transition_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A no-op must stay legal: other services update conversations (last_activity_at)
  -- and some of them will write the column back.
  IF NEW.ai_state IS NOT DISTINCT FROM OLD.ai_state THEN
    RETURN NEW;
  END IF;

  IF (OLD.ai_state, NEW.ai_state) IN (
       ('idle',          'awaiting_ai'),
       ('idle',          'awaiting_staff'),
       ('awaiting_ai',   'idle'),
       ('awaiting_ai',   'awaiting_staff'),
       ('awaiting_ai',   'resolved'),
       ('awaiting_staff','resolved'),
       ('awaiting_staff','awaiting_ai'),
       ('resolved',      'awaiting_ai'),
       -- S07-02: the guest tapped "talk to a person" on a concluded thread.
       ('resolved',      'awaiting_staff')
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'illegal conversation transition % -> % (db/migrations/0017_handoff_from_resolved.sql; see src/conversation/state.ts TRANSITIONS)',
    OLD.ai_state, NEW.ai_state
    USING ERRCODE = 'P0001';
END;
$$;

COMMENT ON COLUMN conversations.ai_state IS
  'Who is expected to speak next (S06-02, widened by S07-02). Guarded by conversations_transition_guard; see src/conversation/state.ts for the same matrix in TypeScript.';

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
      'ai_unavailable'
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT handoff_reasons_reason_code_check ON handoff_reasons IS
  'Appendix B reason codes + ai_unavailable (S07-02). NOT VALID: applies to every new write, tolerates rows written before the vocabulary existed.';

-- The one-tap handoff asks "is there already an open request for this
-- conversation?" before creating a second one. Without this partial index that
-- question scans the property's whole request history, which is the table S09-01
-- will make the busiest in the schema.
CREATE INDEX service_requests_open_by_conversation
  ON service_requests (org_id, property_id, conversation_id)
  WHERE status IN ('new', 'acknowledged', 'assigned');
