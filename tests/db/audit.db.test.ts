import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { withStaffSession, type TenantContext } from "../../src/auth/context.ts";
import { verifyWithJwk, type StaffIdentity } from "../../src/auth/session.ts";
import { requireRole } from "../../src/auth/guard.ts";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import { listAudit } from "../../src/audit/read.ts";
import { writeAudit, AuditWriteError, type AuditEntry } from "../../src/audit/write.ts";
import {
  SupportAccessError,
  writeSupportAccess,
} from "../../src/audit/support.ts";
import {
  loadPropertySettings,
  savePropertySettings,
} from "../../src/settings/store.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

interface Staff {
  email: string;
  neon: string;
  displayName: string;
  userUuid: string;
}

const OWNER_A: Staff = {
  email: "owner@audit-a.mx",
  neon: "auth|audit-owner-a",
  displayName: "Owner A",
  userUuid: "",
};
const OBSERVER_A: Staff = {
  email: "watch@audit-a.mx",
  neon: "auth|audit-observer-a",
  displayName: "Observer A",
  userUuid: "",
};
const OWNER_B: Staff = {
  email: "owner@audit-b.mx",
  neon: "auth|audit-owner-b",
  displayName: "Owner B",
  userUuid: "",
};

const KEY = ecKey("audit-key");

function identity(person: Staff): StaffIdentity {
  return verifyWithJwk(
    mint(
      KEY,
      liveClaims({
        sub: person.neon,
        email: person.email,
        name: person.displayName,
      }),
    ),
    KEY.jwk as never,
    TEST_VERIFY,
  );
}

let client: pg.Client;
let ORG_A = "";
let PROP_A = "";
let ORG_B = "";
let PROP_B = "";
let CONTEXT_A: TenantContext;
let CONTEXT_B: TenantContext;

async function provisionDirect(person: Staff): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");
    const result = await client.query<{ user_id: string }>(
      "SELECT provision_user($1, $2, $3) AS user_id",
      [person.neon, person.email, person.displayName],
    );
    person.userUuid = result.rows[0]!.user_id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function countSettingsAudits(propertyId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*) AS count FROM audit_log WHERE property_id = $1 AND action = 'settings.updated'",
    [propertyId],
  );
  return Number(result.rows[0]!.count);
}

describe("audit log (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    ORG_A = (
      await client.query<{ org_id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('audit_a', 'audit_a') RETURNING org_id",
      )
    ).rows[0]!.org_id;
    PROP_A = (
      await client.query<{ property_id: string }>(
        "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'audit_a_main', 'audit_a_main') RETURNING property_id",
        [ORG_A],
      )
    ).rows[0]!.property_id;
    ORG_B = (
      await client.query<{ org_id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('audit_b', 'audit_b') RETURNING org_id",
      )
    ).rows[0]!.org_id;
    PROP_B = (
      await client.query<{ property_id: string }>(
        "INSERT INTO properties (org_id, name, slug) VALUES ($1, 'audit_b_main', 'audit_b_main') RETURNING property_id",
        [ORG_B],
      )
    ).rows[0]!.property_id;

    CONTEXT_A = { orgId: ORG_A, propertyId: PROP_A };
    CONTEXT_B = { orgId: ORG_B, propertyId: PROP_B };

    for (const [person, propertyId, roleId] of [
      [OWNER_A, PROP_A, 1],
      [OBSERVER_A, PROP_A, 4],
      [OWNER_B, PROP_B, 1],
    ] as Array<[Staff, string, number]>) {
      await provisionDirect(person);
      await client.query(
        "INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, $3)",
        [person.userUuid, propertyId, roleId],
      );
    }
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  it("commits the settings update and its audit row together", async () => {
    const saved = await withStaffSession(
      client,
      CONTEXT_A,
      identity(OWNER_A),
      async (session, tx) => {
        session.requireRole("settings", "write");
        return savePropertySettings(tx, CONTEXT_A, { userId: session.userUuid }, {
          tone: "formal",
        });
      },
    );

    expect(saved.changed).toEqual(["tone"]);
    expect((await loadPropertySettings(client, CONTEXT_A)).tone).toBe("formal");

    const rows = await client.query<{
      actor_user_id: string | null;
      entity_type: string;
      entity_id: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, entity_type, entity_id, detail
         FROM audit_log
        WHERE property_id = $1 AND action = 'settings.updated'
        ORDER BY audit_id DESC`,
      [PROP_A],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.actor_user_id).toBe(OWNER_A.userUuid);
    expect(rows.rows[0]!.entity_type).toBe("property");
    expect(rows.rows[0]!.entity_id).toBe(PROP_A);
    expect(rows.rows[0]!.detail).toEqual({ changed: ["tone"] });
  });

  it("rolls the settings update back when the audit write fails", async () => {
    expect(await countSettingsAudits(PROP_B)).toBe(0);

    await expect(
      withStaffSession(client, CONTEXT_B, identity(OWNER_B), async (session, tx) => {
        session.requireRole("settings", "write");
        return savePropertySettings(
          tx,
          CONTEXT_B,
          { userId: "not-a-uuid" },
          { tone: "concise" },
        );
      }),
    ).rejects.toThrow(AuditWriteError);

    expect((await loadPropertySettings(client, CONTEXT_B)).tone).toBe("warm_professional");
    expect(await countSettingsAudits(PROP_B)).toBe(0);
  });

  it("lists newest first, honours limit/beforeId, and lets an observer read", async () => {
    const extra: AuditEntry[] = [
      {
        orgId: ORG_A,
        propertyId: PROP_A,
        actorUserId: OWNER_A.userUuid,
        action: "membership.granted",
        entityType: "membership",
        entityId: randomUUID(),
      },
      {
        orgId: ORG_A,
        propertyId: PROP_A,
        actorUserId: OWNER_A.userUuid,
        action: "article.version_published",
        entityType: "article_version",
        entityId: randomUUID(),
      },
      {
        orgId: ORG_A,
        propertyId: PROP_A,
        actorUserId: OWNER_A.userUuid,
        action: "conversation.takeover",
        entityType: "conversation",
        entityId: randomUUID(),
      },
    ];

    await withStaffSession(client, CONTEXT_A, identity(OWNER_A), async (_session, tx) => {
      for (const entry of extra) await writeAudit(tx, entry);
    });

    const first = await withStaffSession(
      client,
      CONTEXT_A,
      identity(OBSERVER_A),
      async (session, tx) => {
        session.requireRole("audit", "read");
        return listAudit(tx, CONTEXT_A, { limit: 2 });
      },
    );
    expect(first).toHaveLength(2);
    expect(BigInt(first[0]!.auditId) > BigInt(first[1]!.auditId)).toBe(true);

    const cursor = first[1]!.auditId;
    const older = await withStaffSession(
      client,
      CONTEXT_A,
      identity(OBSERVER_A),
      async (_session, tx) => listAudit(tx, CONTEXT_A, { limit: 2, beforeId: cursor }),
    );
    expect(older).toHaveLength(2);
    expect(older.every((row) => BigInt(row.auditId) < BigInt(cursor))).toBe(true);
    expect(older.some((row) => first.some((head) => head.auditId === row.auditId))).toBe(false);
  });

  it("hides another property's audit rows from staff", async () => {
    const foreign = await withStaffSession(
      client,
      CONTEXT_B,
      identity(OWNER_B),
      async (session, tx) => {
        session.requireRole("audit", "read");
        return listAudit(tx, CONTEXT_A);
      },
    );
    expect(foreign).toEqual([]);
  });

  it("cannot UPDATE or DELETE audit rows", async () => {
    const row = await client.query<{ audit_id: string }>(
      "SELECT audit_id FROM audit_log ORDER BY audit_id LIMIT 1",
    );
    const auditId = row.rows[0]!.audit_id;

    await expect(
      client.query("UPDATE audit_log SET action = 'tampered' WHERE audit_id = $1", [auditId]),
    ).rejects.toThrow(/append-only/);

    for (const statement of [
      "UPDATE audit_log SET action = 'tampered' WHERE audit_id = $1",
      "DELETE FROM audit_log WHERE audit_id = $1",
    ]) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE concierge_app");
        await expect(client.query(statement, [auditId])).rejects.toThrow(/permission denied/);
      } finally {
        await client.query("ROLLBACK");
      }
    }
  });

  it("records support access with operator, reason and ticket", async () => {
    const auditId = await withStaffSession(
      client,
      CONTEXT_A,
      identity(OWNER_A),
      async (session, tx) =>
        writeSupportAccess(tx, CONTEXT_A, {
          actorUserId: session.userUuid,
          operatorEmail: "support@vendor.mx",
          reason: "investigate failed reply",
          ticket: "SUP-42",
        }),
    );

    const row = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      detail: Record<string, unknown>;
    }>(
      "SELECT action, entity_type, entity_id, detail FROM audit_log WHERE audit_id = $1",
      [auditId.toString()],
    );
    expect(row.rows[0]).toEqual({
      action: "support.access",
      entity_type: "property",
      entity_id: PROP_A,
      detail: {
        operator_email: "support@vendor.mx",
        reason: "investigate failed reply",
        ticket: "SUP-42",
      },
    });

    await expect(
      withStaffSession(client, CONTEXT_A, identity(OWNER_A), async (session, tx) =>
        writeSupportAccess(tx, CONTEXT_A, {
          actorUserId: session.userUuid,
          operatorEmail: "support@vendor.mx",
          reason: "   ",
        }),
      ),
    ).rejects.toThrow(SupportAccessError);
  });

  it("keeps audit writes off the staff matrix", () => {
    expect(() => requireRole("owner", "audit", "write")).toThrow();
    expect(() => requireRole("observer", "audit", "write")).toThrow();
  });
});
