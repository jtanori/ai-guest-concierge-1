-- 0012_retrieval_indexes.sql — S04-03: the one index hybrid retrieval needs
-- that 0011 did not already create.
--
-- SCOPE NOTE (charter amended 2026-10-25): §4 of the S04-03 charter lists
-- `gin(tsv)`, `hnsw(embedding vector_cosine_ops)` and `gin(body gin_trgm_ops)`
-- on `article_chunks` here. Those were created in 0011 with the table, because
-- S04-02's own charter claimed them. Re-creating them would be a no-op at best
-- and a duplicate-index bug at worst, so this migration ships only what is
-- genuinely missing.
--
-- WHAT IS MISSING: hybrid fusion resolves a candidate chunk back to its
-- `article_versions` row, and every branch of the fused query filters on
-- `is_current` for a single property. The existing index
-- `article_versions_one_current (article_id) WHERE is_current` cannot answer
-- "the current versions of this property" — it is keyed on the article, not on
-- the tenant column the query filters by, so each candidate becomes a scan.
-- A partial index on (property_id) WHERE is_current is exactly that predicate.

CREATE INDEX article_versions_current_property
  ON article_versions (property_id)
  WHERE is_current;

COMMENT ON INDEX article_versions_current_property IS
  'S04-03: current versions per property, the join key for hybrid fusion. '
  '`org_id` is not in the key: a property belongs to exactly one organization, '
  'and the RLS predicate supplies it.';
