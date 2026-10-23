-- 0003_immutability.sql — S01-01/D5/D10 — immutability triggers.
-- Append-only surfaces: events (D10) and audit_log (S02-03's table but the
-- guarantee ships with the schema), article_versions (D5: edits create rows,
-- historical versions are never rewritten). UPDATE and DELETE on those tables
-- raise an exception; the RESTRICT failures on FKs already protect references.
--
-- article_versions carries the one mutation exemption required by the
-- retrieval design: the embeddings of `article_versions` are backfilled
-- asynchronously after a row is created, and `is_current` moves exactly one
-- way — demotion (true -> false), never a re-ranking of retired history.
-- New versions start is_current = false and become the retrieval surface
-- through the controlled, atomic promote_article_version() step (embed
-- FIRST, then promote) — a plain UPDATE can never mark a version current.

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
  -- The promotion GUC is set (statement-local) by promote_article_version()
  -- below; armed there, a plain UPDATE can still never raise is_current.
  IF (NEW.is_current IS DISTINCT FROM OLD.is_current AND NEW.is_current IS TRUE)
     AND coalesce(current_setting('app.article_version_promotion', true), '') <> 'atomic'
  THEN
    RAISE EXCEPTION 'table article_versions is append-only (only is_current demotion and embedding backfill are permitted; % blocked by db/migrations/0003_immutability.sql)', TG_OP;
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

-- The controlled promotion: demote the current version and raise the target
-- in ONE transaction (this function executes in the caller's), so retrieval
-- never observes a moment without the newly published version, and never
-- observes the old one outliving its replacement in `is_current` memory.
CREATE OR REPLACE FUNCTION promote_article_version(target uuid) RETURNS void
LANGUAGE plpgsql
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
  PERFORM set_config('app.article_version_promotion', 'atomic', true);
  UPDATE article_versions SET is_current = false
   WHERE article_id = v_article AND is_current;
  UPDATE article_versions SET is_current = true
   WHERE article_version_id = target;
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
