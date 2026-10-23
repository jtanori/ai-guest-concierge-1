-- 0003_immutability.sql — S01-01/D5/D10 — immutability triggers.
-- Append-only surfaces: events (D10) and audit_log (S02-03's table but the
-- guarantee ships with the schema), article_versions (D5: edits create rows,
-- historical versions are never rewritten). UPDATE and DELETE on those tables
-- raise an exception; the RESTRICT failures on FKs already protect references.
--
-- article_versions carries the one mutation exemption required by the
-- retrieval design: the embeddings of `article_versions` are backfilled
-- asynchronously after a row is created, and is_current is moved ONLY by the
-- controlled, atomic promote_article_version() step (embed FIRST, then
-- promote) — the trusted path is enforced with a dedicated NOLOGIN role:
-- the trigger only honors is_current UPDATEs issued under
-- concierge_promoter, whose membership is granted solely to the migration
-- owner by this file — the app role from 0002 is deliberately not a member.
-- A custom GUC is NOT a capability — anything can set_config any string —
-- so no session variable gates this code path.

CREATE OR REPLACE FUNCTION raise_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% operation blocked by db/migrations/0003_immutability.sql)',
    TG_TABLE_NAME, TG_OP;
END $$;

-- The trusted promotion context lives only inside the function below.
-- Roles are cluster-scoped (they outlive each test scratch database), so
-- creation is guarded like concierge_app in 0002.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'concierge_promoter') THEN
    CREATE ROLE concierge_promoter NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION article_versions_block_rewrite() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_current IS DISTINCT FROM OLD.is_current
     AND current_user::text <> 'concierge_promoter'
  THEN
    RAISE EXCEPTION 'article_versions.is_current moves only inside promote_article_version() (raw is_current updates are blocked by db/migrations/0003_immutability.sql)';
  END IF;
  IF NEW.article_version_id IS DISTINCT FROM OLD.article_version_id
     OR NEW.org_id          IS DISTINCT FROM OLD.org_id
     OR NEW.property_id     IS DISTINCT FROM OLD.property_id
     OR NEW.article_id      IS DISTINCT FROM OLD.article_id
     OR NEW.version_no      IS DISTINCT FROM OLD.version_no
     OR NEW.body            IS DISTINCT FROM OLD.body
     OR NEW.created_at      IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'table article_versions is append-only (only is_current demotion and embedding backfill are permitted; % blocked by db/migrations/0003_immutability.sql)', TG_OP;
  END IF;
  RETURN NEW;
END $$;

-- Rows are born retired: even a session that controls the table cannot
-- declare a version current via INSERT.
CREATE OR REPLACE FUNCTION article_versions_block_current_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_current IS TRUE THEN
    RAISE EXCEPTION 'article_versions rows insert retired (is_current = false); publish through promote_article_version() (db/migrations/0003_immutability.sql)';
  END IF;
  RETURN NEW;
END $$;

-- The controlled promotion: refuses to publish an unindexed version, then
-- demotes the current version and raises the target in ONE transaction so
-- retrieval never observes a half-swapped state.
CREATE OR REPLACE FUNCTION promote_article_version(target uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_article uuid;
BEGIN
  SELECT article_id INTO v_article
    FROM article_versions
   WHERE article_version_id = target;
  IF v_article IS NULL THEN
    RAISE EXCEPTION 'promote_article_version: unknown article_version_id %', target;
  END IF;
  IF (SELECT embedding IS NULL FROM article_versions WHERE article_version_id = target) THEN
    RAISE EXCEPTION 'cannot promote article_version % before its embedding is backfilled', target;
  END IF;
  UPDATE article_versions SET is_current = false
   WHERE article_id = v_article AND is_current;
  UPDATE article_versions SET is_current = true
   WHERE article_version_id = target;
END $$;

-- SET ROLE cannot happen inside a security-definer function, so the trusted
-- context is enforced by OWNERSHIP instead: the definer of this function IS
-- concierge_promoter, whose identity the trigger verifies.
ALTER FUNCTION promote_article_version(uuid) OWNER TO concierge_promoter;

-- One narrow capability seam: the migration owner may promote (via the
-- function), and the app surface gets a controlled entry point. Direct
-- table UPDATE on is_current is trigger-blocked for everyone else.
GRANT concierge_promoter TO CURRENT_USER;
-- FORCE RLS on article_versions (0002) filters by tenant context, which the
-- promotion step deliberately runs without — so the promoter gets an
-- explicit all-rows policy scoped ONLY to that NOLOGIN role.
CREATE POLICY promoter_swap ON article_versions
  FOR ALL TO concierge_promoter
  USING (true) WITH CHECK (true);
GRANT SELECT (org_id, property_id, article_id, article_version_id, embedding, is_current)
  ON article_versions TO concierge_promoter;
GRANT UPDATE (is_current) ON article_versions TO concierge_promoter;
GRANT EXECUTE ON FUNCTION promote_article_version(uuid) TO concierge_app;
GRANT EXECUTE ON FUNCTION promote_article_version(uuid) TO CURRENT_USER;

DO $$
DECLARE
  immutable_tables text[] := ARRAY['events', 'audit_log'];
  t text;
BEGIN
  FOREACH t IN ARRAY immutable_tables LOOP
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION raise_immutable()', t, t);
  END LOOP;
END $$;

CREATE TRIGGER article_versions_append_only
  BEFORE DELETE ON article_versions
  FOR EACH ROW EXECUTE FUNCTION raise_immutable();
CREATE TRIGGER article_versions_no_rewrite
  BEFORE UPDATE ON article_versions
  FOR EACH ROW EXECUTE FUNCTION article_versions_block_rewrite();
CREATE TRIGGER article_versions_born_retired
  BEFORE INSERT ON article_versions
  FOR EACH ROW EXECUTE FUNCTION article_versions_block_current_insert();
