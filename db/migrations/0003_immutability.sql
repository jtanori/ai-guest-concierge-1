-- 0003_immutability.sql — S01-01/D5/D10 — immutability triggers.
-- Append-only surfaces: events (D10) and audit_log (S02-03's table but the
-- guarantee ships with the schema), article_versions (D5: edits create rows,
-- historical versions are never rewritten). UPDATE and DELETE on those tables
-- raise an exception; the RESTRICT failures on FKs already protect references.
--
-- article_versions carries the one mutation exemption required by the
-- retrieval design: the embeddings of `article_versions` are backfilled
-- asynchronously after a row is created, and is_current is moved ONLY by the
-- controlled, atomic promote_article_version(target) step (embed FIRST, then
-- promote). The trusted path is enforced with a dedicated NOLOGIN role:
-- the trigger only honors is_current UPDATEs issued under
-- concierge_promoter, whose membership goes solely to the migration owner
-- by this file — the app role from 0002 is deliberately not a member.
-- A custom GUC is NOT a capability — anything can set_config any string —
-- and public EXECUTE is revoked explicitly: only the owner and concierge_app
-- may call the function, and the function itself refuses to promote outside
-- the caller's tenant context (verified from the GUCs withTenant sets), so
-- known version ids of a foreign tenant stay useless. A retired version can
-- never be re-promoted: the first promotion stamps `promoted_at`, the
-- trigger refuses any new timestamp on an already-promoted row, and the
-- function refuses retired targets.

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

-- The ownership transfer below requires the migrating role to be able to
-- SET ROLE to the new owner — the membership grant MUST precede it. On Neon
-- the migrating role is NOT a superuser, so the new owner also needs CREATE
-- on the schema it will own the function in (review round 2, 4369257064).
-- 0005_auth_hardening.sql revokes the membership again once the ALTER is
-- done, so the deployed login role cannot SET ROLE into the promoter.
GRANT concierge_promoter TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO concierge_promoter;

CREATE OR REPLACE FUNCTION article_versions_block_rewrite() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_current IS DISTINCT FROM OLD.is_current
     OR NEW.promoted_at IS DISTINCT FROM OLD.promoted_at
  THEN
    IF current_user::text <> 'concierge_promoter' THEN
      RAISE EXCEPTION 'article_versions.is_current moves only inside promote_article_version() (raw is_current updates are blocked by db/migrations/0003_immutability.sql)';
    END IF;
    -- The promotion timestamp is written exactly once: a row already
    -- promoted once is retired history once demoted, and timestamps never
    -- get rewritten.
    IF OLD.promoted_at IS NOT NULL
       AND NEW.promoted_at IS DISTINCT FROM OLD.promoted_at
    THEN
      RAISE EXCEPTION 'retired article_versions are untouchable (promoted_at is recorded once; % blocked by db/migrations/0003_immutability.sql)', TG_OP;
    END IF;
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

-- The controlled promotion: tenant-scoped first, refuses to publish an
-- unindexed version, then demotes the current version and raises the target
-- in ONE transaction so retrieval never observes a half-swapped state.
-- The caller's org/property context (the withTenant GUCs) MUST match the
-- target version — RLS cannot filter inside the definer context, so the
-- function checks explicitly and a foreign tenant version id stays
-- unusable.
CREATE OR REPLACE FUNCTION promote_article_version(target uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_article uuid;
  v_org     uuid;
  v_prop    uuid;
  ctx_org   uuid;
  ctx_prop  uuid;
BEGIN
  SELECT article_id, org_id, property_id INTO v_article, v_org, v_prop
    FROM article_versions
   WHERE article_version_id = target;
  IF v_article IS NULL THEN
    RAISE EXCEPTION 'promote_article_version: unknown article_version_id %', target;
  END IF;

  ctx_org  := nullif(current_setting('app.current_org_id', true), '')::uuid;
  ctx_prop := nullif(current_setting('app.current_property_id', true), '')::uuid;
  IF ctx_org IS NULL OR ctx_prop IS NULL THEN
    RAISE EXCEPTION 'promote_article_version requires the tenant context (app.current_org_id / app.current_property_id) — use the tenant-scoped data access layer';
  END IF;
  IF v_org IS DISTINCT FROM ctx_org OR v_prop IS DISTINCT FROM ctx_prop THEN
    RAISE EXCEPTION 'promote_article_version: % belongs to another tenant', target;
  END IF;

  IF (SELECT embedding IS NULL FROM article_versions WHERE article_version_id = target) THEN
    RAISE EXCEPTION 'cannot promote article_version % before its embedding is backfilled', target;
  END IF;
  -- One-way history: a version that was already promoted (promoted_at set)
  -- and then demoted is retired forever — even this function cannot publish
  -- it again.
  IF (SELECT is_current = false AND promoted_at IS NOT NULL
        FROM article_versions WHERE article_version_id = target) THEN
    RAISE EXCEPTION 'article_version % was promoted once and is retired history; create a new version instead', target;
  END IF;
  UPDATE article_versions SET is_current = false
   WHERE article_id = v_article AND is_current;
  UPDATE article_versions
     SET is_current = true,
         promoted_at = coalesce(promoted_at, now())
   WHERE article_version_id = target;
END $$;

-- SET ROLE cannot happen inside a security-definer function, so the trusted
-- context is enforced by OWNERSHIP instead: the definer of this function IS
-- concierge_promoter, whose identity the trigger verifies.
ALTER FUNCTION promote_article_version(uuid) OWNER TO concierge_promoter;

-- ALTER FUNCTION OWNER discards previous ACLs and the default is EXECUTE
-- FOR PUBLIC, so establish the narrow surface ONLY now.
REVOKE EXECUTE ON FUNCTION promote_article_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION promote_article_version(uuid) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION promote_article_version(uuid) TO concierge_app;

-- FORCE RLS on article_versions (0002) filters by tenant context, which the
-- definer lookup deliberately runs without — so the promoter gets an
-- explicit all-rows policy scoped ONLY to that NOLOGIN role; the tenant
-- scoping itself is the context check inside the function.
CREATE POLICY promoter_swap ON article_versions
  FOR ALL TO concierge_promoter
  USING (true) WITH CHECK (true);
GRANT SELECT (org_id, property_id, article_id, article_version_id, embedding, is_current, promoted_at)
  ON article_versions TO concierge_promoter;
GRANT UPDATE (is_current, promoted_at) ON article_versions TO concierge_promoter;

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
