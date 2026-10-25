-- 0009_property_facts.sql - S03-03: verified, effective-dated facts.
--
-- Hours and prices are data, not prose: the answer to "a que hora cierra la
-- alberca" comes from lookupFact (a verified row), never from the model. 0001
-- gave property_facts only the value, the language and a bare `verified`
-- flag, so nothing recorded WHO verified a fact, WHEN the value takes effect,
-- or WHICH article version it came from (D5's citation link).
--
-- The constraints added here are the integrity half of the service:
--   unit              a closed set, so a closing time is never stored as
--                     arbitrary prose
--   verified_fields   "verified" must name its verifier, its time and its
--                     effective date, or the word means nothing
--   source_version    tenant-composite FK, so a fact can only cite a version
--                     of the same (org, property)
--
-- WHY THE 0001 UNIQUE IS DROPPED: contradiction detection needs two rows with
-- the same key AND the same effective date to coexist - that is exactly what
-- the fixture's pool pair is (21:00 vs 20:00, both closing_time, both
-- 2026-01-01). UNIQUE (property_id, topic_key, fact_key, language) would make
-- the second row impossible, and a different effective_from would hide the
-- pair from listContradictions, whose group key includes effective_from.
-- verifyFact is what refuses the second value; a partial unique index keeps
-- the stronger promise for rows that ARE verified - at most one verified
-- value per key and effective date - while unverified rows stay free to
-- coexist so the contradiction queue can show them.
--
-- No backfill UPDATE: tenant tables are FORCE ROW LEVEL SECURITY, so a
-- migration-time UPDATE would silently run without tenant GUCs and touch
-- nothing. Existing rows take the `unit` default ('text') and stay
-- unverified; the demo seed fills the fixture's unit/effective/source-version
-- values on its ON CONFLICT path. A pre-0009 row that is ALREADY verified
-- would fail property_facts_verified_fields (it has no effective_from) -
-- there are none in local, staging or the fixture, which is why no backfill
-- is attempted.

ALTER TABLE property_facts
  ADD COLUMN unit text NOT NULL DEFAULT 'text',
  ADD COLUMN effective_from date,
  ADD COLUMN source_article_version_id uuid,
  ADD COLUMN verified_by uuid REFERENCES users(user_id),
  ADD COLUMN verified_at timestamptz;

ALTER TABLE property_facts
  ADD CONSTRAINT property_facts_unit_check
    CHECK (unit IN ('text', 'time-of-day', 'hours', 'currency-amount',
                    'duration', 'distance', 'count')),
  ADD CONSTRAINT property_facts_verified_fields
    CHECK (verified = false OR (verified_by IS NOT NULL
                                AND verified_at IS NOT NULL
                                AND effective_from IS NOT NULL)),
  ADD CONSTRAINT property_facts_source_version_fk
    FOREIGN KEY (org_id, property_id, source_article_version_id)
    REFERENCES article_versions (org_id, property_id, article_version_id)
    ON DELETE SET NULL (source_article_version_id);

-- Two rows must be able to share a key while they still disagree (S03-03
-- AC-2/AC-3); see the note at the top.
ALTER TABLE property_facts
  DROP CONSTRAINT property_facts_property_id_topic_key_fact_key_language_key;

-- At most ONE verified value per key + effective date. Partial, so the
-- unverified contradiction pair above is storable.
CREATE UNIQUE INDEX property_facts_verified_key
  ON property_facts (property_id, topic_key, fact_key, language, effective_from)
  WHERE verified;

-- lookupFact's path: exact key, most recent effective date first.
CREATE INDEX property_facts_lookup
  ON property_facts (property_id, topic_key, fact_key, language, effective_from DESC);
