-- 0003_immutability.sql — S01-01/D5/D10 — immutability triggers.
-- Append-only surfaces: events (D10) and audit_log (S02-03's table but the
-- guarantee ships with the schema), article_versions (D5: edits create rows,
-- historical versions are never rewritten). UPDATE and DELETE on those tables
-- raise an exception; the RESTRICT failures on FKs already protect references.
--
-- article_versions carries the one mutation exemption required by the
-- retrieval design: `is_current` may only be DEMOTED (true -> false, never
-- re-raised) and `embedding` may be backfilled asynchronously after the row
-- is created. Everything else rewrites are blocked — the caller creates a new
-- version row instead, which the BEFORE INSERT trigger below automatically
-- demotes predecessors for, keeping "at most one current version per article"
-- (0001's partial unique index) reachable through writes.

CREATE OR REPLACE FUNCTION raise_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% operation blocked by db/migrations/0003_immutability.sql)',
    TG_TABLE_NAME, TG_OP;
END $$;

CREATE OR REPLACE FUNCTION article_versions_block_rewrite() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.article_version_id IS DISTINCT FROM OLD.article_version_id
     OR NEW.org_id          IS DISTINCT FROM OLD.org_id
     OR NEW.property_id     IS DISTINCT FROM OLD.property_id
     OR NEW.article_id      IS DISTINCT FROM OLD.article_id
     OR NEW.version_no      IS DISTINCT FROM OLD.version_no
     OR NEW.body            IS DISTINCT FROM OLD.body
     OR NEW.created_at      IS DISTINCT FROM OLD.created_at
     OR (NEW.is_current IS DISTINCT FROM OLD.is_current AND NEW.is_current IS TRUE)
  THEN
    RAISE EXCEPTION 'table article_versions is append-only (only is_current demotion and embedding backfill are permitted; % blocked by db/migrations/0003_immutability.sql)', TG_OP;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION article_versions_demote_previous() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_current IS TRUE THEN
    -- Demote every predecessor; the immutability trigger permits exactly
    -- this shape of UPDATE (is_current -> false, nothing else touched).
    UPDATE article_versions SET is_current = false
     WHERE article_id = NEW.article_id;
  END IF;
  RETURN NEW;
END $$;

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
CREATE TRIGGER article_versions_current
  BEFORE INSERT ON article_versions
  FOR EACH ROW EXECUTE FUNCTION article_versions_demote_previous();
