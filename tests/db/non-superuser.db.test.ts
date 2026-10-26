/**
 * S02-01 review round 2 — migrations and RLS under a NON-superuser owner.
 *
 * Docker/CI migrations run as a superuser, which hides two production-only
 * failures: ALTER FUNCTION ... OWNER needs the new owner to hold CREATE on
 * the schema, and a login role left inside a definer role can SET ROLE into
 * its USING(true) policy. This suite creates a database owned by a plain
 * LOGIN role (the Neon shape), runs every migration as that role, and proves
 * both are closed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { appPoolConfig } from "../../src/neon/postgres.ts";
import { scratchAdminUrl } from "./helpers.db.ts";

const ROLE = `neon_owner_${process.pid}`;
const DB = `scratch_ns_${process.pid}`;
const PASSWORD = "neon_owner_pw";
const CLUSTER_ROLES = [
  "concierge_app",
  // 0015 adds the guest lookup role; like the others it is cluster-scoped, so
  // the owner needs ADMIN OPTION on it to be able to grant it on a Neon-shaped
  // cluster (where it may already exist from another database).
  "concierge_public",
  "concierge_membership",
  "concierge_promoter",
  "concierge_fact_verifier",
];

let admin: pg.Client | null = null;
let app: pg.Client | null = null;
let login: pg.Client | null = null;

function urlFor(db: string, user?: string, password?: string): string {
  const parsed = new URL(scratchAdminUrl());
  parsed.pathname = `/${db}`;
  if (user) parsed.username = user;
  if (password) parsed.password = password;
  return parsed.toString();
}

describe("non-superuser owner (db)", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: scratchAdminUrl() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await admin.query(`CREATE ROLE ${ROLE} LOGIN CREATEROLE PASSWORD '${PASSWORD}'`);
    await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);

    // Extensions need superuser; the migration only asserts they exist.
    const extensions = new pg.Client({ connectionString: urlFor(DB) });
    await extensions.connect();
    try {
      await extensions.query("CREATE EXTENSION IF NOT EXISTS vector");
      await extensions.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    } finally {
      await extensions.end();
    }

    // The cluster-scoped roles may already exist from another suite; give the
    // fresh owner ADMIN OPTION so it can transfer ownership (the Neon owner
    // creates them on a virgin cluster and holds the same power).
    for (const role of CLUSTER_ROLES) {
      await admin.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE ${role} NOLOGIN;
          END IF;
        END $$`);
      await admin.query(`GRANT ${role} TO ${ROLE} WITH ADMIN OPTION`);
    }

    const applied = await migrateDatabase(urlFor(DB, ROLE, PASSWORD));
    expect(applied).toBe(16);

    // What the migrations granted, the migrations revoked: no membership in
    // any definer role was granted BY the owner itself.
    const selfGrants = await admin.query<{ role: string }>(
      `SELECT roleid::regrole AS role
         FROM pg_auth_members
        WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)
          AND grantor = (SELECT oid FROM pg_roles WHERE rolname = $1)
          AND roleid IN (SELECT oid FROM pg_roles
                          WHERE rolname IN ('concierge_membership', 'concierge_promoter',
                                            'concierge_fact_verifier'))`,
      [ROLE],
    );
    expect(selfGrants.rows).toHaveLength(0);

    // The scaffolding above (ADMIN OPTION granted by the superuser, with
    // inherit/set enabled) has no production analogue — on a virgin cluster
    // the owner's auto-grant is inert (inherit=false, set=false). Remove it
    // so the assertions below see the production end state.
    for (const role of ["concierge_membership", "concierge_promoter", "concierge_fact_verifier"]) {
      await admin.query(`REVOKE ${role} FROM ${ROLE}`);
    }

    app = new pg.Client(appPoolConfig(urlFor(DB, ROLE, PASSWORD)));
    app.on("error", () => undefined);
    await app.connect();

    login = new pg.Client({ connectionString: urlFor(DB, ROLE, PASSWORD) });
    login.on("error", () => undefined);
    await login.connect();
  });

  afterAll(async () => {
    try {
      await app?.end();
    } catch {
      /* already gone */
    }
    try {
      await login?.end();
    } catch {
      /* already gone */
    }
    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      } catch {
        /* best effort */
      }
      for (const role of CLUSTER_ROLES) {
        try {
          await admin.query(`REVOKE ${role} FROM ${ROLE}`);
        } catch {
          /* membership already revoked */
        }
      }
      try {
        await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
      } catch {
        /* best effort */
      }
      await admin.end();
    }
  });

  it("runs every migration and keeps the pool on concierge_app", async () => {
    const row = await app!.query<{ current: string; session: string }>(
      "SELECT current_user AS current, session_user AS session",
    );
    expect(row.rows[0]!.current).toBe("concierge_app");
    expect(row.rows[0]!.session).toBe(ROLE);
  });

  it("transfers function ownership without a superuser", async () => {
    // Must inspect the SCRATCH database, not the admin connection's database:
    // CI starts from an empty template, so pg_proc there has no functions.
    const rows = await login!.query<{ proname: string; owner: string }>(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('current_membership_role', 'provision_user', 'promote_article_version')`,
    );
    const owners = Object.fromEntries(rows.rows.map((r) => [r.proname, r.owner]));
    expect(owners["current_membership_role"]).toBe("concierge_membership");
    expect(owners["provision_user"]).toBe("concierge_membership");
    expect(owners["promote_article_version"]).toBe("concierge_promoter");
  });

  it("leaves the login role with no usable access to either definer role", async () => {
    // On a virgin cluster PostgreSQL records the CREATEROLE creator's
    // auto-grant as an inert row (MEMBER=true, but inherit/set=false), so the
    // security property is USAGE/SET — not membership — being false.
    const flags = await login!.query<{
      membership_usage: boolean;
      membership_set: boolean;
      promoter_usage: boolean;
      promoter_set: boolean;
      verifier_usage: boolean;
      verifier_set: boolean;
      app_usage: boolean;
      app_set: boolean;
    }>(
      `SELECT pg_has_role(current_user, 'concierge_membership', 'USAGE') AS membership_usage,
              pg_has_role(current_user, 'concierge_membership', 'SET')   AS membership_set,
              pg_has_role(current_user, 'concierge_promoter', 'USAGE')   AS promoter_usage,
              pg_has_role(current_user, 'concierge_promoter', 'SET')     AS promoter_set,
              pg_has_role(current_user, 'concierge_fact_verifier', 'USAGE') AS verifier_usage,
              pg_has_role(current_user, 'concierge_fact_verifier', 'SET')   AS verifier_set,
              pg_has_role(current_user, 'concierge_app', 'USAGE')        AS app_usage,
              pg_has_role(current_user, 'concierge_app', 'SET')          AS app_set`,
    );
    expect(flags.rows[0]!.membership_usage).toBe(false);
    expect(flags.rows[0]!.membership_set).toBe(false);
    expect(flags.rows[0]!.promoter_usage).toBe(false);
    expect(flags.rows[0]!.promoter_set).toBe(false);
    expect(flags.rows[0]!.verifier_usage).toBe(false);
    expect(flags.rows[0]!.verifier_set).toBe(false);
    expect(flags.rows[0]!.app_usage).toBe(true);
    expect(flags.rows[0]!.app_set).toBe(true);

    await expect(login!.query("SET ROLE concierge_membership")).rejects.toThrow(
      /permission denied|must be member/,
    );
    await expect(login!.query("SET ROLE concierge_promoter")).rejects.toThrow(
      /permission denied|must be member/,
    );
    await expect(login!.query("SET ROLE concierge_fact_verifier")).rejects.toThrow(
      /permission denied|must be member/,
    );
  });

  it("shows the creator auto-grant is inert (no inherit, no SET ROLE)", async () => {
    const probe = `ns_definer_${process.pid}`;
    await login!.query(`CREATE ROLE ${probe} NOLOGIN`);
    try {
      const flags = await login!.query<{ usage: boolean; set: boolean }>(
        `SELECT pg_has_role(current_user, $1, 'USAGE') AS usage,
                pg_has_role(current_user, $1, 'SET') AS set`,
        [probe],
      );
      expect(flags.rows[0]!.usage).toBe(false);
      expect(flags.rows[0]!.set).toBe(false);
      await expect(login!.query(`SET ROLE ${probe}`)).rejects.toThrow(
        /permission denied|must be member/,
      );
    } finally {
      await admin!.query(`DROP ROLE IF EXISTS ${probe}`);
    }
  });

  it("keeps FORCE RLS effective for the owning login role (the P1 bypass is closed)", async () => {
    const user = await app!.query<{ user_id: string }>(
      "SELECT provision_user($1, $2, $3) AS user_id",
      ["auth|non-superuser", "ns@example.com", "Non Superuser"],
    );
    const userId = user.rows[0]!.user_id;

    // The login role owns the tables, yet without context it sees NOTHING:
    // FORCE RLS applies and the definer membership it used to inherit is gone.
    for (const table of ["users", "memberships"]) {
      const asLogin = await login!.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
      const asApp = await app!.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
      expect(asLogin.rows[0]!.n).toBe("0");
      expect(asApp.rows[0]!.n).toBe("0");
    }

    await app!.query("BEGIN");
    try {
      await app!.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      const own = await app!.query<{ n: string }>("SELECT count(*) AS n FROM users");
      expect(own.rows[0]!.n).toBe("1");
    } finally {
      await app!.query("ROLLBACK");
    }
  });
});
