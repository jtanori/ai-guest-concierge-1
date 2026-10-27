-- 0030_pii_hygiene.sql — S11-03 — retention for message bodies + no text in events.
--
-- Two changes, both about the same promise: a guest's words are stored in exactly
-- one place, for exactly as long as the retention window says, and nowhere else.
--
-- 1. `messages.body_redacted_at` + a partial index for the retention scan.
-- 2. A CHECK on `events.payload` that refuses the keys a guest's text could hide in.
--
-- Deliberately NOT here: a `message_blocked` event type. Blocked turns are counted
-- (`pii_blocked_total`), not recorded as events, because Appendix C's event list is
-- verbatim from the plan and adding a nineteenth name is a backlog amendment, not an
-- implementation detail. Recorded as S11-03-1 in the runbook.

-- ---------------------------------------------------------------------------
-- 1. Retention
-- ---------------------------------------------------------------------------
--
-- Nullable and not defaulted on purpose: the column records *when we destroyed the
-- text*, and a default of `now()` would claim every existing row had already been
-- redacted. NULL means "this body is still the text the guest wrote".
ALTER TABLE messages ADD COLUMN body_redacted_at timestamptz;

-- The whole scan is "this property's un-redacted messages older than the cutoff".
-- Partial, because a redacted row is never revisited — without the predicate the
-- index grows forever over rows the job can only ever skip. `created_at` second,
-- because the range predicate is on it; `property_id` first, because every tenant
-- statement in this codebase is scoped that way.
CREATE INDEX messages_retention_scan
  ON messages (property_id, created_at)
  WHERE body_redacted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. No message text in event payloads
-- ---------------------------------------------------------------------------
--
-- `events` is append-only (0003's trigger, 0029's REVOKE) and is never redacted by
-- the retention job: aggregates must outlive the messages they count. That is only
-- defensible if the payload cannot carry the text. The writer (`emitEvent`) already
-- refuses a non-object payload, so what this constrains is the path that goes
-- *around* the writer — a migration, a fixture, a psql session.
--
-- `question` is deliberately absent from the list: `knowledge_gap_created` carries
-- the guest's question by design (S09-02 — the queue is built from the sentences
-- nobody could answer), and forbidding it here would break the product's own writer
-- while pretending to have made events text-free. Gap questions are content, not
-- transcript: they are what the hotel is being asked to write an article about.
ALTER TABLE events ADD CONSTRAINT events_payload_no_message_text CHECK (
  NOT (payload ?| ARRAY['body', 'card', 'card_number', 'message_text'])
);
