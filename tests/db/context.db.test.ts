/**
 * S02-01 db suite — withStaffSession end to end.
 *
 * Unlike auth.db.test.ts (which drives the policies directly), these tests
 * exercise the production transaction shape: SET LOCAL ROLE concierge_app,
 * tenant GUCs, provisioning, DB-resolved role, and the bound requireRole.
 * Identities are minted through the real JWKS verifier, so the branded
 * StaffIdentity cannot be forged here (review round 2, 4369257035).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import {
  isStaffIdentity,
  verifyWithJwk,
  type StaffIdentity,
} from "../../src/auth/session.ts";
import {
  EmailCollisionError,
  NoMembershipError,
  RoleNotOnSurfaceError,
  UnknownStaffUserError,
  withStaffSession,
  type TenantContext,
} from "../../src/auth/context.ts";

const KEY = ecKey("ctx-key");

function identity(claims: Record<string, unknown> = {}): StaffIdentity {
  return verifyWithJwk(mint(KEY, liveClaims(claims)), KEY.jwk as never, TEST_VERIFY);
}

interface Staff {
  email: string;
  neon: string;
  displayName: string | null;
  userUuid: string;
}

const OWNER_A: Staff = {
  email: "owner@ctx.mx",
  neon: "auth|ctx-owner",
  displayName: "Owner A",
  userUuid: "",
};
const DESK_A: Staff = {
  email: "desk@ctx.mx",
  neon: "auth|ctx-desk",
  displayName: "Desk A",
  userUuid: "",
};
const CONCURRENT: Staff = {
  email: "concurrent@ctx.mx",
  neon: "auth|ctx-concurrent",
  displayName: "Concurrent",
  userUuid: "",
};

let owner: pg.Client;
let owner2: pg.Client;
let probe: pg.Client;
let ORG_A = "";
let PROP_A = "";
let CONTEXT: TenantContext;

async function provisionDirect(person: Staff): Promise<void> {
  await owner.query("BEGIN");
  try {
    await owner.query("SET LOCAL ROLE concierge_app");
    const res = await owner.query<{ user_id: string }>(
      "SELECT provision_user($1, $2, $3) AS user_id",
      [person.neon, person.email, person.displayName],
    );
    person.userUuid = res.rows[0]!.user_id;
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
}

async function addMembership(person: Staff, propertyId: string, roleId: number): Promise<void> {
  await owner.query(
    "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, $3)",
    [person.userUuid, propertyId, roleId],
  );
}

describe("withStaffSession (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    owner = await connectScratch();
    owner2 = await connectScratch();
    probe = await connectScratch();

    ORG_A = (await owner.query<{ org_id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('ctxa', 'ctxa') RETURNING org_id",
    )).rows[0]!.org_id;
    PROP_A = (await owner.query<{ property_id: string }>(
      "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'ctxa_main', 'ctxa_main') RETURNING property_id",
      [ORG_A],
    )).rows[0]!.property_id;
    CONTEXT = { orgId: ORG_A, propertyId: PROP_A };

    for (const person of [OWNER_A, DESK_A, CONCURRENT]) {
      await provisionDirect(person);
      await addMembership(
        person,
        PROP_A,
        person === OWNER_A ? 1 : 3,
      );
    }
  });

  afterAll(async () => {
    await owner.end();
    await owner2.end();
    await probe.end();
    await dropScratch();
  });

  it("runs tenant work as concierge_app with the DB-resolved role", async () => {
    const result = await withStaffSession(
      owner,
      CONTEXT,
      identity({ sub: OWNER_A.neon, email: OWNER_A.email, name: OWNER_A.displayName }),
      async (session, client) => {
        const who = await client.query<{ u: string }>("SELECT current_user AS u");
        const role = await client.query<{ role: number | null }>(
          "SELECT current_membership_role($1) AS role",
          [PROP_A],
        );
        return {
          user: who.rows[0]!.u,
          sessionRole: session.role,
          dbRole: role.rows[0]!.role,
          userUuid: session.userUuid,
        };
      },
    );
    expect(result.user).toBe("concierge_app");
    expect(result.sessionRole).toBe("owner");
    expect(result.dbRole).toBe(1);
    expect(result.userUuid).toBe(OWNER_A.userUuid);
  });

  it("takes the role from memberships, never from token claims", async () => {
    const result = await withStaffSession(
      owner,
      CONTEXT,
      identity({
        sub: DESK_A.neon,
        email: DESK_A.email,
        name: DESK_A.displayName,
        role: "owner",
      }),
      async (session) => session.role,
    );
    expect(result).toBe("front_desk");
  });

  it("refuses a verified identity with no membership and rolls provisioning back", async () => {
    const stranger = identity({
      sub: "auth|ctx-nomember",
      email: "nomember@ctx.mx",
      name: "No Member",
    });
    await expect(
      withStaffSession(owner, CONTEXT, stranger, async () => undefined),
    ).rejects.toThrow(NoMembershipError);

    const rows = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM users WHERE neon_auth_user_id = $1",
      ["auth|ctx-nomember"],
    );
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("maps an email already bound to another identity to EmailCollisionError", async () => {
    const collision = identity({
      sub: "auth|ctx-collision",
      email: OWNER_A.email,
      name: "Impostor",
    });
    await expect(
      withStaffSession(owner, CONTEXT, collision, async () => undefined),
    ).rejects.toThrow(EmailCollisionError);

    const rows = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM users WHERE neon_auth_user_id = $1",
      ["auth|ctx-collision"],
    );
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("refuses a structurally forged identity (brand is module-private)", async () => {
    const forged = {
      neonAuthUserId: "auth|ctx-owner",
      email: "owner@ctx.mx",
      displayName: "Owner A",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    expect(isStaffIdentity(forged)).toBe(false);
    await expect(
      withStaffSession(owner, CONTEXT, forged as never, async () => undefined),
    ).rejects.toThrow(UnknownStaffUserError);
  });

  it("bound requireRole stops a real write the role may not perform", async () => {
    await withStaffSession(
      owner,
      CONTEXT,
      identity({ sub: OWNER_A.neon, email: OWNER_A.email, name: OWNER_A.displayName }),
      async (session, client) => {
        session.requireRole("settings", "write");
        await client.query("UPDATE properties SET name = 'Casa Nueva' WHERE property_id = $1", [
          PROP_A,
        ]);
      },
    );

    await expect(
      withStaffSession(
        owner,
        CONTEXT,
        identity({ sub: DESK_A.neon, email: DESK_A.email, name: DESK_A.displayName }),
        async (session, client) => {
          session.requireRole("settings", "write");
          await client.query("UPDATE properties SET name = 'Hacked' WHERE property_id = $1", [
            PROP_A,
          ]);
        },
      ),
    ).rejects.toThrow(RoleNotOnSurfaceError);

    const name = await probe.query<{ name: string }>(
      "SELECT name FROM properties WHERE property_id = $1",
      [PROP_A],
    );
    expect(name.rows[0]!.name).toBe("Casa Nueva");
  });

  it("leaves no tenant GUCs behind after the transaction", async () => {
    await withStaffSession(
      owner,
      CONTEXT,
      identity({ sub: OWNER_A.neon, email: OWNER_A.email, name: OWNER_A.displayName }),
      async () => undefined,
    );
    const after = await owner.query<{ v: string | null }>(
      "SELECT nullif(current_setting('app.current_org_id', true), '') AS v",
    );
    expect(after.rows[0]!.v).toBe(null);
  });

  it("provisions concurrent first-logins to the same user (idempotent)", async () => {
    const who = identity({
      sub: CONCURRENT.neon,
      email: CONCURRENT.email,
      name: CONCURRENT.displayName,
    });
    const [a, b] = await Promise.all([
      withStaffSession(owner, CONTEXT, who, async (session) => session.userUuid),
      withStaffSession(owner2, CONTEXT, who, async (session) => session.userUuid),
    ]);
    expect(a).toBe(CONCURRENT.userUuid);
    expect(b).toBe(CONCURRENT.userUuid);

    const rows = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM users WHERE neon_auth_user_id = $1",
      [CONCURRENT.neon],
    );
    expect(rows.rows[0]!.n).toBe("1");
  });

  it("never rewrites an existing identity's email or display name", async () => {
    const changed = identity({
      sub: CONCURRENT.neon,
      email: "changed@ctx.mx",
      name: "Changed Name",
    });
    await withStaffSession(owner, CONTEXT, changed, async () => undefined);

    const row = await owner.query<{ email: string; display_name: string | null }>(
      "SELECT email, display_name FROM users WHERE neon_auth_user_id = $1",
      [CONCURRENT.neon],
    );
    expect(row.rows[0]!.email).toBe(CONCURRENT.email);
    expect(row.rows[0]!.display_name).toBe(CONCURRENT.displayName);
  });
});
