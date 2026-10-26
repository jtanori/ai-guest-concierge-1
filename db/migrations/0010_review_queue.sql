-- 0010_review_queue.sql — S04-01: human approval gates publication, and a
-- contradictory fact group is closed only when a human picks a winner.
--
-- Two tables, because the two halves of the AC have different shapes:
--
--   article_reviews   one decision row per (property, article_version). The AC
--                     is "a contradictory pair is blocked until a human
--                     resolves it" plus AC-1 "no version becomes is_current
--                     without an approval row naming a staff user", so the
--                     decision is a ROW that names its reviewer - never a
--                     mutable column on article_versions. 0003's
--                     article_versions_append_only trigger blocks UPDATEs
--                     there anyway (D5): history is immutable, and the review
--                     decision is separate history.
--
--   fact_resolutions  one row per resolved contradiction group. S03-03's
--                     listContradictions groups on (topic_key, fact_key,
--                     language, effective_from) and reports every group with
--                     more than one distinct value; without a resolution
--                     record a group could never leave the queue, so G1's
--                     "zero unresolved contradictions" would be unprovable.
--                     Recording WHO picked WHICH winner is the audit trail the
--                     resolution screen (S04-01) and the gate both need.
--
-- Both tables are tenant tables: FORCE RLS with the 0002 `tenant` policy shape
-- (org AND property must match the transaction's GUCs), and the same
-- SELECT/INSERT/UPDATE grants concierge_app already holds on every tenant
-- table. No DELETE grant: a decision and a resolution are history.

CREATE TABLE article_reviews (
  review_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  property_id        uuid NOT NULL,
  article_version_id uuid NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Who decided. NULL only while pending; an approval always names a person.
  reviewer_user_id   uuid REFERENCES users(user_id),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- One decision per version: a re-approval updates this row, it does not
  -- stack a second opinion (the reviewer and timestamp move together).
  UNIQUE (property_id, article_version_id),
  FOREIGN KEY (org_id, property_id, article_version_id)
    REFERENCES article_versions (org_id, property_id, article_version_id)
    ON DELETE CASCADE,
  FOREIGN KEY (org_id, property_id) REFERENCES properties (org_id, property_id),
  -- A decided review names its reviewer and its time; a pending one has
  -- neither. This is the DB half of AC-1: "approved" cannot be anonymous.
  CONSTRAINT article_reviews_decision_fields
    CHECK (
      (status = 'pending' AND reviewer_user_id IS NULL AND decided_at IS NULL)
      OR (status <> 'pending' AND reviewer_user_id IS NOT NULL AND decided_at IS NOT NULL)
    )
);

-- The queue: pending rows for one property, oldest first.
CREATE INDEX article_reviews_queue
  ON article_reviews (property_id, status, requested_at);

-- 0001 keyed property_facts on fact_id alone, so a composite FK has nothing
-- to point at. This index (fact_id is already unique, so it adds no rows of
-- meaning) gives the tenant-composite reference below a target: a resolution
-- can only name a winner fact from ITS OWN (org, property), exactly like
-- 0009's source_version FK. Without it the FK would be either impossible or
-- single-column, and a bug could file a resolution against another tenant's
-- fact id.
ALTER TABLE property_facts
  ADD CONSTRAINT property_facts_tenant_key UNIQUE (org_id, property_id, fact_id);

CREATE TABLE fact_resolutions (
  resolution_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  property_id     uuid NOT NULL,
  topic_key       text NOT NULL,
  fact_key        text NOT NULL,
  language        text NOT NULL,
  effective_from  date,
  winner_fact_id  uuid NOT NULL,
  resolved_by     uuid NOT NULL REFERENCES users(user_id),
  resolved_at     timestamptz NOT NULL DEFAULT now(),
  -- The group key IS the identity of a resolution, including the nullable
  -- effective date: NULLS NOT DISTINCT (PG15+) so the legacy NULL group can
  -- only be resolved once, matching S03-03's IS NOT DISTINCT FROM grouping.
  UNIQUE NULLS NOT DISTINCT (property_id, topic_key, fact_key, language, effective_from),
  FOREIGN KEY (org_id, property_id, winner_fact_id)
    REFERENCES property_facts (org_id, property_id, fact_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, property_id) REFERENCES properties (org_id, property_id)
);

-- ---------- RLS + grants (the 0002 tenant-table shape) ----------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['article_reviews', 'fact_resolutions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I USING (org_id = current_org_id() AND property_id = current_property_id()) WITH CHECK (org_id = current_org_id() AND property_id = current_property_id())',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO concierge_app', t);
  END LOOP;
END $$;
