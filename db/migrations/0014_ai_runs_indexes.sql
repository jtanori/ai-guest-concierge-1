-- 0014_ai_runs_indexes.sql — S05-03: any historical answer reconstructable
-- from the database.
--
-- NOTE ON THE NUMBER: the S05-03 charter calculated `0013_ai_runs_indexes.sql`.
-- 0013 is taken by S04-03's `retrieval_weights`, and the charter says to rebase
-- migration numbers on whatever merges first. This is that rebase.
--
-- WHAT WAS MISSING. `ai_runs` and `citations` have existed since 0001 with the
-- right columns, and S05-01 now writes them on every call. Reconstruction was
-- still unindexed: `ai_runs` was only reachable through its primary key and
-- `(org_id, property_id)`, so "this property's last 50 answers" was a scan of
-- every answer the product has ever produced, and every reconstructed answer
-- joined `citations` on a column with no index at all. Under RLS both queries
-- carry `org_id`/`property_id` predicates, so both indexes lead with them.
--
-- WHY A CHECK ON `usage` SHAPE. `usage` is `NOT NULL DEFAULT '{}'` but its type
-- is unconstrained, so a caller that writes an array (a token list, a provider's
-- `usageMetadata` array) stores something no reader can read as a map. The check
-- makes that a 23514 at write time instead of a 3am surprise in a dashboard.

CREATE INDEX ai_runs_property_time ON ai_runs (property_id, created_at DESC);

-- Reconstructing one answer joins citations by run; the tenant columns stay in
-- the key because RLS adds them to every predicate and the planner should be
-- able to use one index for the whole lookup.
CREATE INDEX citations_run ON citations (org_id, property_id, ai_run_id);

ALTER TABLE ai_runs
  ADD CONSTRAINT ai_runs_usage_object CHECK (jsonb_typeof(usage) = 'object');

COMMENT ON INDEX ai_runs_property_time IS
  'S05-03: per-property answer history, newest first (RLS predicates included).';
COMMENT ON INDEX citations_run IS
  'S05-03: reconstructAnswer joins citations by (tenant, ai_run_id).';
