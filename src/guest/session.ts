/**
 * S06-01 — the guest session: the highest-risk tenancy path in the product.
 *
 * A stranger arrives with a URL slug and no identity. Everything the request is
 * allowed to touch is decided by the row that slug resolves to, so the order of
 * operations IS the security design:
 *
 *   1. `BEGIN`.
 *   2. Switch DOWN to `concierge_public` (0015) and set `app.property_slug`
 *      from the URL. The role can read exactly one row: the one whose slug
 *      matches, and only six of its columns.
 *   3. Read `(org_id, property_id, time_zone, languages, name, slug)`. No row
 *      means 404 — an unknown slug and a slug belonging to someone else are
 *      indistinguishable by construction.
 *   4. Switch UP to `concierge_app` and set the tenant GUCs from THAT row. From
 *      here on, RLS scopes every statement to the slug's tenant.
 *   5. Run the caller's work in the same transaction, then COMMIT or ROLLBACK.
 *
 * What this file deliberately does not accept: an org id, a property id, a
 * conversation id or an identity id from the request body. The only tenant
 * input is the slug in the URL, and the only identity input is a signed cookie
 * (see `cookie.ts`) whose property must equal the slug's property.
 *
 * The staff session (`withStaffSession`) is NOT reused here and must not be: it
 * resolves a membership from a verified JWT, which a guest does not have. The
 * two paths share `assertTenantShape` and the same GUC contract, nothing else.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import { parsePropertySettings } from "../settings/schema.ts";

/** Unknown, malformed and ambiguous slugs all land here — one 404, no oracle. */
export class UnknownPropertyError extends Error {
  constructor(slug: string) {
    super(`no public property with slug "${slug}"`);
    this.name = "UnknownPropertyError";
  }
}

/** The public half of a property row: exactly what 0015 grants. */
export interface PublicProperty {
  orgId: string;
  propertyId: string;
  name: string;
  slug: string;
  timeZone: string;
  /** Declared guest languages, e.g. `["es","en"]`. Used for the reply language default. */
  languages: string[];
  /**
   * S07-01 — the origins allowed to frame the chat (settings `embed`).
   *
   * Read under the APP role, not the lookup role: `concierge_public` holds a
   * column grant on `properties` that deliberately excludes `settings` (0015),
   * because settings carry staff contacts. This one field is copied out after
   * the role switch rather than granted away.
   */
  frameAncestors: string[];
}

export interface GuestSession {
  context: TenantContext;
  property: PublicProperty;
}

/** Property slugs are URL segments; anything else never reaches the database. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const PUBLIC_LOOKUP_SQL = `
  SELECT org_id, property_id, name, slug, time_zone, languages
    FROM properties
   WHERE slug = $1
`;

interface PropertyRow {
  org_id: string;
  property_id: string;
  name: string;
  slug: string;
  time_zone: string;
  languages: string[];
}

/**
 * S07-01 — `embed.allowed_origins` for this property, or `[]`.
 *
 * Deliberately forgiving: settings are validated on write (0006/0013/0020 and
 * `parsePropertySettings`), so a value that fails to parse here means somebody
 * wrote past both. The guest still gets the chat; only embedding is refused.
 */
async function loadFrameAncestors(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<string[]> {
  const result = await client.query<{ settings: unknown }>(
    "SELECT settings FROM properties WHERE org_id = $1 AND property_id = $2",
    [context.orgId, context.propertyId],
  );
  const settings = result.rows[0]?.settings;
  try {
    const parsed = parsePropertySettings(settings);
    return [...parsed.embed.allowed_origins];
  } catch {
    return [];
  }
}

export class GuestRoleUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `the guest lookup role is unavailable: ${detail}. The deployment's login role ` +
        "must be a member of concierge_public (db/migrations/0015_guest_chat.sql)",
    );
    this.name = "GuestRoleUnavailableError";
  }
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42501";
}

/**
 * Resolves the slug and runs `fn` inside the tenant transaction it establishes.
 * Accepts a Pool or a PoolClient (a Pool takes one connection for the whole
 * call, so SET LOCAL and the queries share a session — the same rule
 * `withTenant` follows).
 */
export async function withGuestSession<T>(
  client: pg.Client | pg.PoolClient,
  slug: string,
  fn: (session: GuestSession, scoped: pg.Client | pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    // A malformed slug is a 404, not a 400: telling a stranger which strings
    // are well-formed is free reconnaissance.
    throw new UnknownPropertyError(String(slug));
  }

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_public");
    await client.query("SELECT set_config('app.property_slug', $1, true)", [slug]);

    const found = await client.query<PropertyRow>(PUBLIC_LOOKUP_SQL, [slug]);
    const row = found.rows[0];
    if (row === undefined) throw new UnknownPropertyError(slug);

    // The slug column is globally unique (0001), so "more than one row" cannot
    // happen; the lookup is still written as a single-row read so a future
    // schema change that relaxes that fails loudly here instead of silently
    // picking a tenant.
    if (found.rowCount !== 1) {
      throw new UnknownPropertyError(slug);
    }

    const property: PublicProperty = {
      orgId: row.org_id,
      propertyId: row.property_id,
      name: row.name,
      slug: row.slug,
      timeZone: row.time_zone,
      languages: row.languages,
      // Filled in below, once the app role can read settings. A default here
      // (rather than a placeholder) is what makes a missing key fail closed:
      // no allowlist means no embedder.
      frameAncestors: [],
    };
    const context: TenantContext = { orgId: property.orgId, propertyId: property.propertyId };
    assertTenantShape(context);

    try {
      await client.query("SET LOCAL ROLE concierge_app");
    } catch (error) {
      if (isPermissionDenied(error)) throw new GuestRoleUnavailableError((error as Error).message);
      throw error;
    }
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [context.orgId]);
    await client.query("SELECT set_config('app.current_property_id', $1, true)", [context.propertyId]);

    // S07-01: the embed allowlist, read now that the app role is in force. A
    // settings row that does not parse must not 500 a guest page — the chat is
    // the product, embedding is a distribution channel — so a parse failure is
    // logged and treated as "nobody may embed".
    property.frameAncestors = await loadFrameAncestors(client, context);

    const result = await fn({ context, property }, client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if (isPermissionDenied(error) && !(error instanceof GuestRoleUnavailableError)) {
      throw new GuestRoleUnavailableError((error as Error).message);
    }
    throw error;
  }
}
