/**
 * S02-01 db suite — identity helpers + the staff surfaces under RLS.
 *
 * Everything runs as concierge_app inside transactions that both set the
 * tenant context AND app.current_user_id, exactly the shape
 * withStaffSession produces in production. The owner (superuser) session is
 * only for seeding, never for assertions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  connectScratch,
  dropScratch,
  recreateScratch,
} from "./helpers.db.ts";

const parse = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A person during seed; userUuid fills in once provision runs. */
interface Staff {
  email: string;
  neon: string;
  displayName?: string;
  userUuid: string;
}

let owner: pg.Client;
let client: pg.Client;

/** Mirrors isolation.db.test.ts: the app session shape (role + rollback on error). */
async function asStaffApp(fn: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");
    await fn();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function setStaff(person: Staff): Promise<pg.QueryResult> {
  return client.query("SELECT set_config('app.current_user_id', $1, true)", [person.userUuid]);
}

function setTenant(orgId: string, propertyId: string): Promise<pg.QueryResult> {
  return client.query(
    "SELECT set_config('app.current_org_id', $1, true), set_config('app.current_property_id', $2, true)",
    [orgId, propertyId],
  );
}

/** provision_user under concierge_app, inside its own committed tx. */
async function provision(person: Staff): Promise<string> {
  await asStaffApp(async () => {
    const res = await client.query<{ user_id: string }>(
      "SELECT provision_user($1, $2, $3) AS user_id",
      [person.neon, person.email, person.displayName ?? null],
    );
    person.userUuid = res.rows[0]!.user_id;
  });
  expect(parse.test(person.userUuid)).toBe(true);
  return person.userUuid;
}

const OWNER_A: Staff = { email: "gm@autha.mx", neon: "auth|owner-a", displayName: "GM A", userUuid: "" };
const MANAGER_A: Staff = { email: "mgr@autha.mx", neon: "auth|manager-a", displayName: "Manager A", userUuid: "" };
const DESK_A: Staff = { email: "desk@autha.mx", neon: "auth|desk-a", displayName: "Desk A", userUuid: "" };
const WATCHER_A: Staff = { email: "watch@autha.mx", neon: "auth|watch-a", displayName: "Watcher A", userUuid: "" };
const OUTSIDER: Staff = { email: "nobody@authb.mx", neon: "auth|outsider", displayName: "Nobody B", userUuid: "" };

let ORG_A = "", PROP_A = "";
let ORG_B = "", PROP_B = "";

describe("staff identity + four roles under RLS (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    owner = await connectScratch();
    client = await connectScratch();

    ORG_A = (await owner.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('autha', 'autha') RETURNING org_id",
    )).rows[0]!.org_id;
    PROP_A = (await owner.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'autha_main', 'autha_main') RETURNING property_id",
      [ORG_A],
    )).rows[0]!.property_id;
    ORG_B = (await owner.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('authb', 'authb') RETURNING org_id",
    )).rows[0]!.org_id;
    PROP_B = (await owner.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'authb_main', 'authb_main') RETURNING property_id",
      [ORG_B],
    )).rows[0]!.property_id;

    for (const person of [OWNER_A, MANAGER_A, DESK_A, WATCHER_A]) {
      const user = await provision(person);
      await owner.query(
        "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, $3)",
        [user, PROP_A, person === OWNER_A ? 1 : person === MANAGER_A ? 2 : person === DESK_A ? 3 : 4],
      );
    }
    const b = await provision(OUTSIDER);
    await owner.query(
      "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 3)",
      [b, PROP_B],
    );
  });

  afterAll(async () => {
    // Graceful disconnect BEFORE the scratch drop so no connection notices
    // the database vanishing underneath it.
    await owner.end();
    await client.end();
    await dropScratch();
  });

  it("resolves the DB-side role for every one of the four roles", async () => {
    for (const [person, expected] of [
      [OWNER_A, 1], [MANAGER_A, 2], [DESK_A, 3], [WATCHER_A, 4],
    ] as Array<[Staff, number]>) {
      await asStaffApp(async () => {
        await setTenant(ORG_A, PROP_A);
        await setStaff(person);
        const res = await client.query<{ role: number | null }>(
          "SELECT current_membership_role($1) AS role", [PROP_A]);
        expect(res.rows[0]!.role).toBe(expected);
      });
    }
  });

  it("returns no role for a staff member of another property", async () => {
    await asStaffApp(async () => {
      await setTenant(ORG_B, PROP_B);
      await setStaff(DESK_A);
      const res = await client.query<{ role: number | null }>(
        "SELECT current_membership_role($1) AS role", [PROP_B]);
      expect(res.rows[0]!.role).toBe(null);
    });
  });

  it("exposes memberships of your property and never another property's", async () => {
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(MANAGER_A);
      const visible = await client.query<{ property_id: string }>(
        "SELECT m.property_id FROM memberships m",
      );
      expect(visible.rows).toHaveLength(4);
      expect(visible.rows.every((r) => r.property_id === PROP_A)).toBe(true);
    });
  });

  it("rejects role-grant writes from a manager (RLS, not route enforcement)", async () => {
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(MANAGER_A);
      await expect(
        client.query(
          "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 2)",
          [WATCHER_A.userUuid, PROP_A],
        ),
      ).rejects.toThrow(/policy|permission denied/);
    });
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(MANAGER_A);
      await expect(
        client.query("UPDATE memberships SET role_id = 1 WHERE user_id = $1", [MANAGER_A.userUuid]),
      ).rejects.toThrow(/policy|permission denied/);
    });
  });

  it("allows owner-side membership writes for the owned property only", async () => {
    // Positive path: the GM of A grants DESK-role membership on A to the
    // visitor who only works for B.
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(OWNER_A);
      await expect(
        client.query(
          "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 3)",
          [OUTSIDER.userUuid, PROP_A],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
    // Negative path: the same GM cannot extend their grant to property B.
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(OWNER_A);
      await expect(
        client.query(
          "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, 3)",
          [MANAGER_A.userUuid, PROP_B],
        ),
      ).rejects.toThrow(/policy|permission denied/);
    });
  });

  it("shows a staff member only themselves in users (member lists come from memberships)", async () => {
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(DESK_A);
      const res = await client.query<{ user_id: string }>("SELECT user_id FROM users");
      expect(res.rows.map((row) => row.user_id)).toEqual([DESK_A.userUuid]);
    });
  });
});
