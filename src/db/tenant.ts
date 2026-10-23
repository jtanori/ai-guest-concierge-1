/**
 * S01-02 — application-layer tenant guard (D1's other half).
 *
 * RLS enforces isolation in the database; this module enforces *context* in
 * the application: every tenant query runs inside a transaction that has set
 * `app.current_org_id` / `app.current_property_id`, and the helper refuses to
 * run tenant work outside one. A query without tenant context returns zero
 * rows at the SQL layer (S01-02 AC) and no route should ever be able to skip
 * the guard by accident.
 */
import type pg from "pg";

export class TenantContextError extends Error {}

export interface TenantContext {
  orgId: string;
  propertyId: string;
}

/** Shared shape validation used by withTenant and the staff session guard. */
export function assertTenantShape(context: TenantContext): void {
  if (typeof context.orgId !== "string" || context.orgId.length === 0) {
    throw new TenantContextError("orgId is required — tenant work is never org-less");
  }
  if (typeof context.propertyId !== "string" || context.propertyId.length === 0) {
    throw new TenantContextError("propertyId is required — tenant work is never property-less");
  }
  assertUuid(context.orgId, "orgId");
  assertUuid(context.propertyId, "propertyId");
}

function assertUuid(value: string, field: string): void {
  const parsed = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!parsed.test(value)) {
    throw new TenantContextError(`${field} must be a uuid, got "${value}"`);
  }
}

/**
 * Runs `fn` in a transaction with SET LOCAL tenant context. The context is
 * transaction-scoped: it cannot leak into the next query, and an exception
 * rolls the whole unit back.
 *
 * Accepts a Pool or PoolClient: on a Pool a dedicated client is taken for the
 * whole call so SET LOCAL and the queries share one session.
 */
export async function withTenant<T>(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  fn: (scoped: pg.Client | pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof context.orgId !== "string" || context.orgId.length === 0) {
    throw new TenantContextError("orgId is required — tenant work is never org-less");
  }
  if (typeof context.propertyId !== "string" || context.propertyId.length === 0) {
    throw new TenantContextError("propertyId is required — tenant work is never property-less");
  }
  assertUuid(context.orgId, "orgId");
  assertUuid(context.propertyId, "propertyId");

  await client.query("BEGIN");
  try {
    // SET cannot bind parameters; set_config(..., local := true) is the
    // transaction-scoped equivalent.
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [context.orgId]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [context.propertyId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
