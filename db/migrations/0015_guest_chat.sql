-- 0015_guest_chat.sql — S06-01 — the one privileged read the public surface needs.
--
-- The guest route knows a SLUG and nothing else. Producing `(org_id, property_id)`
-- from it requires reading `properties`, which is a FORCE-RLS tenant table: with
-- no tenant context it returns zero rows, deliberately. A SECURITY DEFINER
-- helper cannot help — FORCE RLS applies to the table OWNER too (that is the
-- whole point of `FORCE`), and BYPASSRLS needs a superuser Neon does not give
-- us.
--
-- So the lookup gets a role of its own, and the role gets the smallest possible
-- window:
--
--   * `concierge_public` is NOLOGIN and holds no grants on any tenant table. It
--     exists to be SET ROLE'd into for exactly one SELECT.
--   * Its only privilege is COLUMN-level SELECT on six public columns of
--     `properties` — not `settings`, not `ai_mode`, not `created_at`. `SELECT *`
--     fails for it, which is a property under test rather than a comment.
--   * Its only row is the one whose `slug` equals `app.property_slug`, a
--     transaction-local GUC the caller sets from the URL. The role therefore
--     cannot enumerate the directory: it can read the slug the request named,
--     and nothing else. (The data is public by design, but "public" is not
--     "listable" and the difference is worth keeping.)
--
-- The request path then switches UP to `concierge_app` with the tenant GUCs set
-- from the row it just read, and never comes back down. Tenant comes from the
-- URL slug; it is never accepted from a body (tests assert that).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'concierge_public') THEN
    CREATE ROLE concierge_public NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO concierge_public;

-- Switching DOWN needs concierge_app to be a member; switching back UP needs the
-- session user to hold SET on concierge_app, which the pool already arranges.
GRANT concierge_public TO concierge_app;

-- The role that applies migrations is the deployment's login role on Neon, and
-- the request session may be that role (appPoolConfig sets `role=concierge_app`
-- through startup options, so `session_user` stays the login role). Grant the
-- membership explicitly so the down-switch does not depend on a superuser.
DO $$
BEGIN
  EXECUTE format('GRANT concierge_public TO %I', current_user);
END $$;

GRANT SELECT (org_id, property_id, name, slug, time_zone, languages)
  ON properties TO concierge_public;

DROP POLICY IF EXISTS public_slug ON properties;
CREATE POLICY public_slug ON properties
  FOR SELECT TO concierge_public
  USING (slug = current_setting('app.property_slug', true));

-- A guest conversation is created by the request that starts it; the identity
-- row it hangs off is anonymous and addressable only through a signed cookie.
-- No new table is needed for that (0001 has channel_identities, conversations
-- and messages), so this migration adds no RLS surface: the three tables are
-- already FORCE-RLS tenant tables covered by 0002 and by the isolation suite.
--
-- RESIDUAL RISK, recorded rather than papered over: SECURITY DEFINER functions
-- in this schema still carry PostgreSQL's default EXECUTE to PUBLIC, so
-- `concierge_public` could in principle call `provision_user`. Revoking that
-- default needs the *function* owner (concierge_membership), which the
-- migration role is not — tidying it belongs in a dedicated hardening item, not
-- in a silent ACL change here. The role is never used for anything but the one
-- SELECT below, and it is NOLOGIN.
