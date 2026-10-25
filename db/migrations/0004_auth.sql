-- 0004_auth.sql — S02-01 — staff identity and the four roles (D1/D3/Vercel).
--
-- Auth provider: Neon Auth (managed Better Auth). Verified JWTs (via JWKS)
-- identify staff; the users row is provisioned by the SECURITY DEFINER
-- provision function below so a non-superuser pool under FORCE RLS can still
-- create exactly one user per verified identity (and nothing else).
--
-- The role (owner / manager / front_desk / observer) is NEVER trusted from
-- the client: it is read from memberships under RLS by
-- current_membership_role(), whose membership view is anchored to
-- app.current_user_id. Ownership of the definer functions sits with the
-- dedicated NOLOGIN role concierge_membership (cluster-scoped, so creation is
-- guarded like concierge_app in 0002 and concierge_promoter in 0003); a GUC
-- is not a capability — membership in this role is granted only for the
-- ALTER FUNCTION OWNER below and REVOKED before this migration commits, so
-- neither the app role nor the deployed login role can SET ROLE into it
-- (review round 2, 4369257029).
--
-- users and memberships stop being global: users are self-visible only
-- (member lists come from memberships), membership rows are visible to the
-- member themselves and to any staff of that same property, and writing
-- memberships for other people is an owner-only action.

-- 1. The trusted definer role for identity helpers.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'concierge_membership') THEN
    CREATE ROLE concierge_membership NOLOGIN;
  END IF;
END $$;

-- Policies do not grant privileges; the definer role needs its own table
-- rights to read memberships and write users rows (provisioning's upsert).
GRANT SELECT, INSERT, UPDATE ON users        TO concierge_membership;
GRANT SELECT, INSERT, UPDATE ON memberships  TO concierge_membership;

-- 2. The identity helpers themselves (defined before the policies below
--    reference them).
CREATE OR REPLACE FUNCTION current_membership_role(target_property uuid)
  RETURNS smallint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.role_id
    FROM memberships m
   WHERE m.user_id = uuid(nullif(current_setting('app.current_user_id', true), ''))
     AND m.property_id = target_property
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION provision_user(
  p_neon_auth_user_id text,
  p_email             text,
  p_display_name      text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- Called ONLY with facts from a JWKS-verified JWT (see src/auth/session.ts).
  -- Idempotent AND race-safe: the single-statement upsert resolves both the
  -- first insert of an unseen identity and concurrent callers for the same
  -- identity (the DO UPDATE action fires for the conflict loser and
  -- RETURNING emits that row; no separate UPDATE-then-INSERT window). An
  -- existing identity is NEVER re-addressed: email and display_name are
  -- immutable here (display_name only fills a NULL), so even a compromised
  -- app session holding EXECUTE cannot use provisioning to take over an
  -- account or rewrite an identity (review round 2, 4369257051). A
  -- genuinely-new identity that collides on ANOTHER identity's email
  -- (uniqueness there) still surfaces the constraint to the route layer,
  -- which maps it to EmailCollisionError — that attempt belongs to a
  -- different person, not a retry.
  INSERT INTO users (neon_auth_user_id, email, display_name)
       VALUES (p_neon_auth_user_id, p_email, p_display_name)
  ON CONFLICT (neon_auth_user_id) DO UPDATE
         SET display_name = COALESCE(users.display_name, EXCLUDED.display_name)
      RETURNING user_id INTO v_user_id;
  RETURN v_user_id;
END $$;

-- 3. Ownership + ACLs: the helpers are definer-owned by the NOLOGIN role so a
--    compromised app session can neither escalate through nor re-define them
--    (only the migration owner may). TRANSFER ownership first, then grant
--    membership — ALTER ... OWNER also discards ACLs, and the EXECUTE grant
--    to PUBLIC that the change restores is revoked explicitly afterwards
--    (order matches the promotion function in 0003). A non-superuser
--    migration role (Neon) can only transfer ownership to a role that has
--    CREATE on the schema, hence the grant below (review round 2,
--    4369257064). The membership is REVOKED again before COMMIT: on Neon the
--    deployed login role IS the migration role, and leaving it a member made
--    `SET ROLE concierge_membership` — and its USING(true) policy — reachable
--    from the application connection, bypassing RLS (review round 2,
--    4369257029).
GRANT CREATE ON SCHEMA public TO concierge_membership;
GRANT concierge_membership TO CURRENT_USER;
ALTER FUNCTION current_membership_role(uuid)
  OWNER TO concierge_membership;
ALTER FUNCTION provision_user(text, text, text)
  OWNER TO concierge_membership;

REVOKE EXECUTE ON FUNCTION current_membership_role(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION provision_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_membership_role(uuid) TO concierge_app;
GRANT EXECUTE ON FUNCTION provision_user(text, text, text) TO concierge_app;

-- The app pool connects as the login role and SET ROLEs into concierge_app
-- (src/neon/postgres.ts); that is the ONLY membership the login role keeps.
REVOKE concierge_membership FROM CURRENT_USER;
GRANT concierge_app TO CURRENT_USER;

-- 4. All-rows access for the definer context: identities and memberships
--    must be readable inside current_membership_role()/provision_user()
--    regardless of who is calling.
CREATE POLICY identity_definer ON users
  FOR ALL TO concierge_membership USING (true) WITH CHECK (true);
CREATE POLICY identity_definer ON memberships
  FOR ALL TO concierge_membership USING (true) WITH CHECK (true);

-- 5. Self-visible users. A staff member learns nothing about accounts beyond
--    their own; member lists read the memberships surface instead. Split per
--    command (review round 2, 4369257052): the UPDATE policy only authorizes
--    the caller's own row, and the column grant below makes display_name the
--    ONLY writable column — INSERT/DELETE are revoked outright (users are
--    born through provision_user, and deleting an account is not a staff
--    action), so email/identity takeover is impossible even with a route bug.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_select ON users
  FOR SELECT TO concierge_app
  USING (user_id = uuid(nullif(current_setting('app.current_user_id', true), '')));
CREATE POLICY staff_update_name ON users
  FOR UPDATE TO concierge_app
  USING (user_id = uuid(nullif(current_setting('app.current_user_id', true), '')))
  WITH CHECK (user_id = uuid(nullif(current_setting('app.current_user_id', true), '')));
REVOKE INSERT, UPDATE, DELETE ON users FROM concierge_app;
GRANT UPDATE (display_name) ON users TO concierge_app;

-- 6. Memberships: the tenant-scoped staff surface — split per command
--    (FOR ALL policies authorize DELETE off USING alone, which would let any
--    member erase coworkers; only select-and-write need the distinct rules).
--    Reads: your own row, or any membership of a property you belong to.
--    Writes: owner-only, enforced here rather than in the route, so no
--    endpoint bug can grant a role. Deletes: owner-only plus your own row
--    (self-leave is safe; revoking someone else is not).
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_select ON memberships
  FOR SELECT TO concierge_app
  USING (
    user_id = uuid(nullif(current_setting('app.current_user_id', true), ''))
    OR current_membership_role(property_id) IS NOT NULL
  );
CREATE POLICY membership_insert ON memberships
  FOR INSERT TO concierge_app
  WITH CHECK (current_membership_role(property_id) = 1);
CREATE POLICY membership_update ON memberships
  FOR UPDATE TO concierge_app
  USING (current_membership_role(property_id) = 1)
  WITH CHECK (current_membership_role(property_id) = 1);
CREATE POLICY membership_delete ON memberships
  FOR DELETE TO concierge_app
  USING (
    user_id = uuid(nullif(current_setting('app.current_user_id', true), ''))
    OR current_membership_role(property_id) = 1
  );
