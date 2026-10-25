/**
 * S02-01 — staff sessions bound to the tenant guard.
 *
 * The staff-side counterpart of withTenant (S01-02): one transaction sets
 * the tenant GUCs AND the caller's user id, so the DATABASE resolves the
 * caller's role via current_membership_role() (db/migrations/0004_auth.sql,
 * SECURITY DEFINER under RLS). The role never comes from the token or the
 * request body — it is read from memberships, where RLS keeps property B
 * unreadable to staff of property A even if the request carries B's ids.
 *
 * Refusal ladder, before any tenant work runs:
 *   - unknown identity (not JWKS-verified)  → UnknownStaffUserError
 *   - verified but no membership in the tx's property → NoMembershipError
 *   - every further write needs the surface matrix (guard.ts) — the session
 *     object carries requireRole bound to the resolved role.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import { requireRole, ROLE_BY_ID, type Mode, type Role, type Surface } from "./guard.ts";
import { isStaffIdentity, type StaffIdentity } from "./session.ts";

export { can, requireRole, RoleNotOnSurfaceError } from "./guard.ts";
export type { TenantContext } from "../db/tenant.ts";

export interface StaffSession {
  userUuid: string;
  role: Role;
  /** Bound requireRole — throws RoleNotOnSurfaceError on the session's role. */
  requireRole: (surface: Surface, mode: Mode) => void;
}

export class UnknownStaffUserError extends Error {}
export class NoMembershipError extends Error {}
/** A verified identity whose email is already bound to a different Neon user. */
export class EmailCollisionError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Runs `fn` inside one transaction shaped like withTenant, with the caller's
 * membership resolved. `identity` arrives from a JWKS-verified JWT
 * (src/auth/session.ts); provision_user makes the users-row mapping
 * idempotent so a verified identity always lands on the same user id.
 */
export async function withStaffSession<T>(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  identity: StaffIdentity,
  fn: (session: StaffSession, scoped: pg.Client | pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!isStaffIdentity(identity)) {
    throw new UnknownStaffUserError("identity is not JWKS-verified — refusing to run");
  }
  if (!identity.neonAuthUserId || !identity.email) {
    throw new UnknownStaffUserError("identity is not JWKS-verified — refusing to run");
  }
  if (identity.expiresAt <= Date.now() / 1000) {
    throw new UnknownStaffUserError("session token expired");
  }
  assertTenantShape(context);

  await client.query("BEGIN");
  try {
    // The pool's startup role already does this, but SET LOCAL ROLE here
    // makes the guarantee hold for every caller (tests, scripts, a
    // misconfigured pool): tenant work NEVER runs as a table-owning login
    // role. Superusers can SET ROLE too, so local dev is covered.
    await client.query("SET LOCAL ROLE concierge_app");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [context.orgId]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [context.propertyId]);

    let provisioned: pg.QueryResult<{ user_id: string }>;
    try {
      provisioned = await client.query<{ user_id: string }>(
        "SELECT provision_user($1, $2, $3) AS user_id",
        [identity.neonAuthUserId, identity.email, identity.displayName],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EmailCollisionError(
          "this verified email is already bound to a different Neon Auth user",
        );
      }
      throw error;
    }
    const userUuid = provisioned.rows[0]!.user_id;
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userUuid]);

    const membership = await client.query<{ role: number | null }>(
      "SELECT current_membership_role($1) AS role",
      [context.propertyId],
    );
    const roleId = membership.rows[0]!.role;
    if (roleId === null) throw new NoMembershipError(`no membership in property ${context.propertyId}`);
    const role = ROLE_BY_ID[roleId];
    if (!role) throw new NoMembershipError(`membership row references unknown role_id ${roleId}`);

    const session: StaffSession = {
      userUuid,
      role,
      requireRole: (surface, mode) => requireRole(role, surface, mode),
    };
    const result = await fn(session, client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
