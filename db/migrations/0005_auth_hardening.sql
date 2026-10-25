-- 0005_auth_hardening.sql — S02-01 review round 2 — definer-role hygiene.
--
-- 0003 predates the definer-role rules 0004 establishes: it leaves the
-- migration owner as a member of concierge_promoter after transferring the
-- promotion function to it. On Neon the deployed login role IS the migration
-- owner, so that membership let the application connection run
-- `SET ROLE concierge_promoter` and reach the promoter's USING(true) policy —
-- a full RLS bypass (review round 2, 4369257029). Revoke it here; 0004
-- already revokes the equivalent membership for concierge_membership.
--
-- The grants below are idempotent for databases that applied the first cut of
-- 0003/0004: the definer roles need CREATE on the schema for
-- ALTER FUNCTION ... OWNER under a non-superuser migration role
-- (4369257064), and the login role needs membership in concierge_app to
-- SET ROLE into it (the app pool's startup role, src/neon/postgres.ts).
GRANT CREATE ON SCHEMA public TO concierge_membership;
GRANT CREATE ON SCHEMA public TO concierge_promoter;

REVOKE concierge_membership FROM CURRENT_USER;
REVOKE concierge_promoter FROM CURRENT_USER;

GRANT concierge_app TO CURRENT_USER;
