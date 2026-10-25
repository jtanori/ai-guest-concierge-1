/**
 * S02-02 - tenant-scoped settings store.
 *
 * Both functions assume the caller is already inside `withTenant` /
 * `withStaffSession`: RLS scopes the row and the WHERE guard keeps the write
 * addressed to exactly one property. No role checks live here; routes use
 * `guard.requireRole("settings", ...)`.
 */
import type pg from "pg";
import {
  mergeSettings,
  parsePropertySettings,
  SETTINGS_KEYS,
  type PropertySettings,
  type SettingsKey,
} from "./schema.ts";

export interface PropertyContext {
  orgId: string;
  propertyId: string;
}

export class PropertyNotFoundError extends Error {
  constructor(context: PropertyContext) {
    super(
      `property ${context.propertyId} was not found in org ${context.orgId} (or is not visible in this context)`,
    );
    this.name = "PropertyNotFoundError";
  }
}

export async function loadPropertySettings(
  client: pg.Client,
  context: PropertyContext,
): Promise<PropertySettings> {
  const result = await client.query<{ settings: unknown }>(
    "SELECT settings FROM properties WHERE org_id = $1 AND property_id = $2",
    [context.orgId, context.propertyId],
  );
  if (result.rowCount !== 1) throw new PropertyNotFoundError(context);
  return parsePropertySettings(result.rows[0]!.settings);
}

export async function savePropertySettings(
  client: pg.Client,
  context: PropertyContext,
  patch: Partial<PropertySettings>,
): Promise<{ settings: PropertySettings; changed: SettingsKey[] }> {
  const current = await loadPropertySettings(client, context);
  const settings = mergeSettings(current, patch);

  const result = await client.query(
    "UPDATE properties SET settings = $1::jsonb WHERE org_id = $2 AND property_id = $3",
    [JSON.stringify(settings), context.orgId, context.propertyId],
  );
  if (result.rowCount !== 1) throw new PropertyNotFoundError(context);

  const changed = SETTINGS_KEYS.filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(settings[key]),
  );

  return { settings, changed };
}
