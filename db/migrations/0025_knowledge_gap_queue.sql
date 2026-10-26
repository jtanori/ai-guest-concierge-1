-- 0025_knowledge_gap_queue.sql — S09-02 — the queue the content owner reads.
--
-- `knowledge_gaps` has existed since 0001 and two writers have been inserting
-- into it since S05-02/S07-03: `src/ai/answer.ts` on both no-answer paths, and
-- `src/requests/capture.ts` when it rode along with one. Neither deduped against
-- the other by property, so the same unanswered question could appear once per
-- conversation forever. A queue that shows "what time does the pool open?"
-- eleven times is a queue nobody reads, and the count that matters — how many
-- guests hit this miss — was thrown away instead of recorded.
--
-- This makes the row a *queue entry*: one open row per distinct unanswered
-- question per property, with the number of times it was asked.

-- ---------- 1. the columns ---------------------------------------------------

ALTER TABLE knowledge_gaps
  ADD COLUMN topic text,
  ADD COLUMN hits  integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN knowledge_gaps.hits IS
  'S09-02: how many times this question was asked and not answered, while the gap stayed open. The number that tells a content owner what to write first.';

-- 1 is the floor: a gap row exists because it was asked at least once, and a
-- zero would make "asked 0 times" indistinguishable from "never asked".
ALTER TABLE knowledge_gaps
  ADD CONSTRAINT knowledge_gaps_hits_positive CHECK (hits >= 1);

-- The dedupe key.
--
-- A generated column rather than an index on `lower(question)` for one concrete
-- reason: a btree key is capped at ~2704 bytes, and guest messages are
-- attacker-controlled text with no length limit at this layer. Indexing
-- `lower(question)` directly would turn a long question into an insert *error* —
-- i.e. a guest who writes a paragraph breaks their own reply. Capping the key at
-- 400 characters keeps every insert working and costs one acceptable ambiguity:
-- two questions identical in their first 400 characters merge. They are almost
-- certainly the same question, and merging them over-counts nothing that matters.
--
-- `btrim` before `left`, so trailing whitespace and letter case cannot split one
-- question into two queue entries. The QUESTION column keeps the guest's exact
-- text — the key is for matching, the column is what a human reads.
--
-- `lower()` alone is NOT enough, and this is not a hypothetical: on a database
-- initialised with the C/POSIX collation, `lower('¿A QUÉ HORA')` returns
-- '¿a quÉ hora' — ASCII folds, accented capitals do not. So the same question
-- shouted and asked would occupy two queue entries on one deployment and one on
-- another, depending on a locale flag nobody thinks about. For a product whose
-- working language is Spanish, that is the common case rather than the corner.
--
-- `translate()` folds the Spanish capitals explicitly, before `lower()` handles
-- the rest. It is locale-independent, so the key is the same key everywhere —
-- which also matters because the key is what the unique index compares, and an
-- index whose meaning changes with the server's collation is an index that
-- cannot be reasoned about.
ALTER TABLE knowledge_gaps
  ADD COLUMN question_key text
    GENERATED ALWAYS AS (
      left(btrim(lower(translate(question, 'ÁÉÍÓÚÜÑÇ', 'áéíóúüñç'))), 400)
    ) STORED;

-- ---------- 2. merge what is already duplicated ------------------------------
--
-- The unique index below cannot be created while two open rows share a key, and
-- on a database that has been running since S05-02 they do. So the duplicates are
-- merged first: the OLDEST row survives (its `created_at` is the honest "how long
-- has this gone unanswered"), the others' existence is folded into `hits`.
--
-- This deletes rows. That is deliberate and worth saying plainly: the duplicates
-- are not distinct history, they are one event recorded twice by two writers, and
-- keeping them would keep the double-count the item exists to remove. The
-- `knowledge_gap_created` events already emitted for a deleted row stay in
-- `events` — append-only, and their payload names a gap_id that no longer
-- resolves, which is the normal fate of a log entry outliving its subject.
-- Not `ON COMMIT DROP`.
--
-- src/db/migrate.ts wraps a whole file in one transaction, so `ON COMMIT DROP`
-- looks harmless there. It is not: run the file statement-by-statement — psql -f
-- in autocommit, a restore, a manual hotfix, any tool that does not know this
-- repo's runner convention — and each statement commits, the table is dropped
-- immediately, and the migration dies at the UPDATE *after* the ALTERs have
-- already landed. That is a half-migrated database, which is worse than a clean
-- failure. A plain temporary table is dropped at session end anyway, so nothing
-- is given up by not asking for it early.
CREATE TEMPORARY TABLE gap_merge AS
SELECT
  property_id,
  question_key,
  (array_agg(gap_id ORDER BY created_at, gap_id))[1] AS keeper_id,
  count(*)::integer                                   AS merged_hits
FROM knowledge_gaps
WHERE status = 'open'
GROUP BY property_id, question_key
HAVING count(*) > 1;

-- Every pre-migration row has hits = 1 (the column is new), so the merged count
-- is the number of rows folded together.
UPDATE knowledge_gaps g
   SET hits = m.merged_hits
  FROM gap_merge m
 WHERE g.gap_id = m.keeper_id;

DELETE FROM knowledge_gaps g
 USING gap_merge m
 WHERE g.status = 'open'
   AND g.property_id = m.property_id
   AND g.question_key = m.question_key
   AND g.gap_id <> m.keeper_id;

-- ---------- 3. the indexes ---------------------------------------------------

-- One open gap per question per property. Partial: resolving a gap must let the
-- same question be asked again and recorded again, because "we wrote the article
-- and they are still asking" is a different fact from "we never answered".
CREATE UNIQUE INDEX knowledge_gaps_open_question
  ON knowledge_gaps (property_id, question_key)
  WHERE status = 'open';

COMMENT ON INDEX knowledge_gaps_open_question IS
  'S09-02: the queue holds one open row per distinct unanswered question per property. Repeats increment hits.';

-- The queue itself: open gaps for a property, hottest and oldest first.
CREATE INDEX knowledge_gaps_queue
  ON knowledge_gaps (property_id, status, created_at DESC);

-- ---------- 4. the shape a closed gap must have ------------------------------
--
-- The same rule 0023 added for service_requests: `resolved_at` was free-floating,
-- so nothing stopped a row claiming to be open and resolved at once — which makes
-- "median age of an open gap" answerable only by guessing which column to trust.
ALTER TABLE knowledge_gaps
  ADD CONSTRAINT knowledge_gaps_resolved_shape
  CHECK (resolved_at IS NULL OR status = 'resolved');

COMMENT ON CONSTRAINT knowledge_gaps_resolved_shape ON knowledge_gaps IS
  'S09-02: a gap cannot be open and resolved at once. The median-age metric reads status; this keeps resolved_at from contradicting it.';
