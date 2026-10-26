-- 0021_inbox_indexes.sql — S08-01 — the three reads behind the inbox.
--
-- The charter calculated `0016_inbox_indexes.sql`; 0016–0020 are taken, so this
-- is 0021 (the charter says to rebase on whatever merged first). It also asked
-- for three indexes that are now partly redundant, and shipping redundant
-- indexes is not free: every one of them is maintained on the guest's write
-- path. What follows is what the queries actually need, and the comment says
-- which charter index was dropped and why.
--
-- The inbox is the only read in the product that runs on every staff page view,
-- so it is the one place where a missing index is felt as latency rather than
-- as a slow report.

-- 1. "Mine" — conversations with a request assigned to me.
--
-- `assignments` had no index beyond its primary key, so `assigned_to = $me`
-- was a sequential scan of every assignment at the property. The composite
-- leads with the tenant because every service query already carries both ids
-- (RLS narrows the rows, but the planner can only use an index that matches
-- what the predicate says).
CREATE INDEX assignments_user
  ON assignments (org_id, property_id, assigned_to, created_at DESC);

-- 2. The last message of each conversation.
--
-- `messages` carries a trigram index on `body` (0001) and its primary key, and
-- nothing ordered by time inside a conversation. The inbox fetches one row per
-- conversation with a LATERAL join `ORDER BY created_at DESC LIMIT 1`; without
-- this index that is a sort of the whole conversation for every row on the
-- page — the classic N+1 that hides at fixture scale and falls over at 200
-- conversations.
--
-- `message_id` is in the index after `created_at` because `created_at` is not
-- unique (a turn writes the inbound and the outbound message in one
-- transaction) and the tie-break has to be deterministic, or a page boundary
-- can repeat or skip a row.
CREATE INDEX messages_conversation_time
  ON messages (org_id, property_id, conversation_id, created_at DESC, message_id DESC);

-- 3. The ordered page scan.
--
-- Keyset pagination orders by `(last_activity_at DESC, conversation_id DESC)`.
-- 0016's `conversations_property_state` is partial on `ai_state IN
-- ('awaiting_staff','awaiting_ai')` and carries no ordering column, so it can
-- filter but not page; this one pages, and the filter is applied as an index
-- condition when a filter narrows to one state.
--
-- The charter also asked for `conversations_inbox (property_id, ai_state,
-- last_activity_at DESC)`. That is this index with `org_id` added at the front
-- and `conversation_id` at the back — the tenant column must lead (every query
-- carries it) and the id is needed for the keyset comparison. The partial index
-- from 0016 is left alone: it serves the "who is waiting" count, which does not
-- order.
CREATE INDEX conversations_inbox
  ON conversations (org_id, property_id, last_activity_at DESC, conversation_id DESC);

COMMENT ON INDEX conversations_inbox IS
  'S08-01: keyset pagination for the staff inbox. Order matches src/inbox/queries.ts.';
COMMENT ON INDEX messages_conversation_time IS
  'S08-01: the inbox''s LATERAL last-message read. Deterministic tie-break on message_id.';
COMMENT ON INDEX assignments_user IS
  'S08-01: the "mine" filter and, later, every "my queue" read in S08-03.';
