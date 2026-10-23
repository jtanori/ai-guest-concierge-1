-- 0002_rls.sql — S01-02 — Row-level security on every tenant table (D1).
--
-- Context model: the application sets `app.current_org_id` and
-- `app.current_property_id` (SET LOCAL, per transaction) via src/db/tenant.ts.
-- No context (empty string after current_setting()) → NULL → zero rows.
-- A context pair that mismatches an org/property membership → zero rows, which
-- is also how the S01-03 isolation suite probes every tenant table.
--
-- Policies are forced (FORCE ROW LEVEL SECURITY) so the migration role cannot
-- silently bypass them on Neon, where the owner role is not a superuser.
-- The `concierge_app` NOLOGIN role exists for the CI tester to SET ROLE into:
-- superusers always bypass RLS (docker/CI service), so tests must drop into a
-- non-superuser role to exercise the policies for real.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'concierge_app') THEN
    CREATE ROLE concierge_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO concierge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO concierge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO concierge_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO concierge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO concierge_app;

CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE CALLED ON NULL INPUT
SET search_path = pg_catalog
AS $$ SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION current_property_id() RETURNS uuid
LANGUAGE sql STABLE CALLED ON NULL INPUT
SET search_path = pg_catalog
AS $$ SELECT NULLIF(current_setting('app.current_property_id', true), '')::uuid $$;

DO $$
DECLARE
  tenant_tables text[] := ARRAY[
    'properties',
    'channel_connections', 'channel_identities',
    'conversations', 'messages', 'message_delivery_events',
    'service_requests', 'assignments', 'internal_notes',
    'knowledge_sources', 'knowledge_articles', 'article_versions', 'property_facts',
    'ai_runs', 'citations', 'handoff_reasons', 'knowledge_gaps',
    'events', 'rollups', 'audit_log', 'outbox'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO concierge_app', t);
    IF t = 'properties' THEN
      -- org-scoped: a property row is visible when its org matches context.
      EXECUTE format(
        'CREATE POLICY tenant ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())', t);
    ELSE
      -- property-scoped: BOTH context values must match the row's own columns,
      -- so a mismatched org/property pair also yields zero rows.
      EXECUTE format(
        'CREATE POLICY tenant ON %I USING (org_id = current_org_id() AND property_id = current_property_id()) WITH CHECK (org_id = current_org_id() AND property_id = current_property_id())', t);
    END IF;
  END LOOP;
END $$;

-- Users + memberships are role-scoped in S02 once auth exists; they are NOT
-- tenant tables above, so no policy here — S02-01 closes their surface rules.
