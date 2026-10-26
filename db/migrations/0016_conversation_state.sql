-- 0016_conversation_state.sql — S06-02 — illegal transitions impossible.
--
-- The charter calculated `0014`; 0013/0014/0015 are taken, so this is 0016 (the
-- charter says to rebase on whatever merged first).
--
-- `conversations.status` (open/closed) already exists and is orthogonal: it is
-- the guest's thread being closed, not who is expected to speak next. `ai_state`
-- is that second axis, and it is the one the product needs — "did a human take
-- this over, and may the model still talk?" — because containment (the north
-- star) is measured as conversations with zero staff messages, and a takeover
-- that the AI can talk over afterwards is not a takeover.
--
-- The guard is a trigger, not application code, for one reason: the rule has to
-- hold for raw SQL too. A background job, a migration, a psql session or a
-- future service that has not read this file must all be subject to the same
-- matrix. The application keeps its own copy of the matrix
-- (src/conversation/state.ts) so a caller gets a typed error before the round
-- trip — but the trigger is the authority.
--
-- Why a trigger and not a CHECK constraint: a CHECK cannot see the OLD row, and
-- "which transitions are legal" is by definition a statement about a pair.

ALTER TABLE conversations
  ADD COLUMN ai_state text NOT NULL DEFAULT 'idle'
    CHECK (ai_state IN ('idle', 'awaiting_ai', 'awaiting_staff', 'resolved'));

COMMENT ON COLUMN conversations.ai_state IS
  'Who is expected to speak next (S06-02). Guarded by conversations_transition_guard; see src/conversation/state.ts for the same matrix in TypeScript.';

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
       ('resolved',      'awaiting_ai')
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'illegal conversation transition % -> % (db/migrations/0016_conversation_state.sql; see src/conversation/state.ts TRANSITIONS)',
    OLD.ai_state, NEW.ai_state
    USING ERRCODE = 'P0001';
END;
$$;

-- Scoped to the column: a write that does not touch `ai_state` (the hot path is
-- last_activity_at) must not pay for a trigger it cannot affect.
DROP TRIGGER IF EXISTS conversations_transition_guard ON conversations;
CREATE TRIGGER conversations_transition_guard
  BEFORE UPDATE OF ai_state ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION conversations_transition_guard();

-- The "who is waiting" queue (S08-01) reads this, and it is the one column the
-- inbox filters on that is not already indexed.
CREATE INDEX conversations_property_state
  ON conversations (org_id, property_id, ai_state)
  WHERE ai_state IN ('awaiting_staff', 'awaiting_ai');
