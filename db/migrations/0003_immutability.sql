-- 0003_immutability.sql — S01-01/D5/D10 — immutability triggers.
-- Append-only surfaces: events (D10) and audit_log (S02-03's table but the
-- guarantee ships with the schema), article_versions (D5: edits create rows,
-- historical versions are never rewritten). UPDATE and DELETE on those tables
-- raise an exception; the RESTRICT failures on FKs already protect references.

CREATE OR REPLACE FUNCTION raise_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% operation blocked by db/migrations/0003_immutability.sql)',
    TG_TABLE_NAME, TG_OP;
END $$;

DO $$
DECLARE
  immutable_tables text[] := ARRAY['events', 'audit_log', 'article_versions'];
  t text;
BEGIN
  FOREACH t IN ARRAY immutable_tables LOOP
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION raise_immutable()', t, t);
  END LOOP;
END $$;
