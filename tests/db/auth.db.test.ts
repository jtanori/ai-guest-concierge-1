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

  it("rejects role-grant writes from a manager (RLS filters the rows, not route checks)", async () => {
    // The manager's own row fails the write policy's role_id=1 check, so the
    // UPDATE is RLS-filtered into a silent no-op — never an escalation.
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(MANAGER_A);
      const self = await client.query(
        "UPDATE memberships SET role_id = 1 WHERE user_id = $1",
        [MANAGER_A.userUuid],
      );
      expect(self.rowCount).toBe(0);
    });
    // Ground truth: the manager is still a manager.
    const stillManager = await owner.query<{ role: number }>(
      "SELECT role_id AS role FROM memberships WHERE user_id = $1",
      [MANAGER_A.userUuid],
    );
    expect(stillManager.rows[0]!.role).toBe(2);
    // Inserts for another person are refused outright by the with check.
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

  it("rejects membership DELETEs from non-owner staff (kill-the-team test)", async () => {
    // The reviewer's attack: desk/observer staff erasing coworkers, possibly
    // the owner. The DELETE policy only admits the owner — everyone else's
    // DELETE is RLS-filtered into a silent no-op (rowCount 0), even though
    // the row itself is visible to them for reads.
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(DESK_A);
      const gone = await client.query("DELETE FROM memberships WHERE user_id = $1", [
        OWNER_A.userUuid,
      ]);
      expect(gone.rowCount).toBe(0);
    });
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(WATCHER_A);
      const gone = await client.query("DELETE FROM memberships WHERE user_id = $1", [
        MANAGER_A.userUuid,
      ]);
      expect(gone.rowCount).toBe(0);
    });
    // Ground truth via the owner session: nobody else's membership vanished.
    const sessions = await owner.query<{ n: string }>("SELECT count(*) AS n FROM memberships");
    expect(sessions.rows[0]!.n).toBe("6");
  });

  it("permits a staff member to delete ONLY their own membership (self-leave)", async () => {
    // Self-leave is safe (cannot lock anyone else out). After leaving, the
    // staff member cannot see membership rows AT ALL: the visibility policy
    // derives from membership, so the table goes fully invisible to them.
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(WATCHER_A);
      const before = await client.query<{ n: string }>("SELECT count(*) AS n FROM memberships");
      expect(before.rows[0]!.n).toBe("5");
      const self = await client.query("DELETE FROM memberships WHERE user_id = $1", [
        WATCHER_A.userUuid,
      ]);
      expect(self.rowCount).toBe(1);
      const after = await client.query<{ n: string }>("SELECT count(*) AS n FROM memberships");
      expect(after.rows[0]!.n).toBe("0");
    });
    // Ground truth via the owner session: the other members all survived.
    const survivors = await owner.query<{ n: string }>("SELECT count(*) AS n FROM memberships");
    expect(survivors.rows[0]!.n).toBe("5");
  });

  it("shows a staff member only themselves in users (member lists come from memberships)", async () => {
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(DESK_A);
      const res = await client.query<{ user_id: string }>("SELECT user_id FROM users");
      expect(res.rows.map((row) => row.user_id)).toEqual([DESK_A.userUuid]);
    });
  });

  it("never rewrites an existing identity during provisioning (review round 2)", async () => {
    const fresh: Staff = {
      email: "fresh@autha.mx",
      neon: "auth|fresh-idem",
      displayName: "Fresh",
      userUuid: "",
    };
    await provision(fresh);
    await asStaffApp(async () => {
      const res = await client.query<{ user_id: string }>(
        "SELECT provision_user($1, $2, $3) AS user_id",
        [fresh.neon, "changed@autha.mx", "Changed"],
      );
      expect(res.rows[0]!.user_id).toBe(fresh.userUuid);
    });
    const row = await owner.query<{ email: string; display_name: string | null }>(
      "SELECT email, display_name FROM users WHERE user_id = $1",
      [fresh.userUuid],
    );
    expect(row.rows[0]!.email).toBe(fresh.email);
    expect(row.rows[0]!.display_name).toBe("Fresh");
  });

  it("rejects provisioning an email already bound to another identity", async () => {
    await expect(
      asStaffApp(async () => {
        await client.query("SELECT provision_user($1, $2, $3)", [
          "auth|email-thief",
          DESK_A.email,
          null,
        ]);
      }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("makes users self-visible with display_name as the only writable column", async () => {
    await asStaffApp(async () => {
      await setTenant(ORG_A, PROP_A);
      await setStaff(DESK_A);
      const renamed = await client.query(
        "UPDATE users SET display_name = $2 WHERE user_id = $1",
        [DESK_A.userUuid, "Desk Renamed"],
      );
      expect(renamed.rowCount).toBe(1);
    });

    // Email takeover, inserts and deletes are privileges the app never holds.
    await expect(
      asStaffApp(async () => {
        await setTenant(ORG_A, PROP_A);
        await setStaff(DESK_A);
        await client.query("UPDATE users SET email = $2 WHERE user_id = $1", [
          DESK_A.userUuid,
          "evil@autha.mx",
        ]);
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asStaffApp(async () => {
        await setTenant(ORG_A, PROP_A);
        await setStaff(DESK_A);
        await client.query("INSERT INTO users (email) VALUES ('intruder@autha.mx')");
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asStaffApp(async () => {
        await setTenant(ORG_A, PROP_A);
        await setStaff(DESK_A);
        await client.query("DELETE FROM users WHERE user_id = $1", [DESK_A.userUuid]);
      }),
    ).rejects.toThrow(/permission denied/);

    const ground = await owner.query<{ email: string; display_name: string | null }>(
      "SELECT email, display_name FROM users WHERE user_id = $1",
      [DESK_A.userUuid],
    );
    expect(ground.rows[0]!.email).toBe(DESK_A.email);
    expect(ground.rows[0]!.display_name).toBe("Desk Renamed");
  });

  it("returns zero users and memberships without context (no-context invariant)", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE concierge_app");
      for (const table of ["users", "memberships"]) {
        const res = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        expect(res.rows[0]!.n).toBe("0");
      }
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
