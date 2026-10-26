/**
 * S08-04 — the pure half of the mode writer.
 *
 * The database cases (`tests/db/ai-modes.db.test.ts`) prove the mode applies to
 * the next message. What can be wrong without a cluster is the ordering: an
 * observer's attempt must cost zero queries, and an invalid mode must be refused
 * before any lock is taken.
 */
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { RoleNotOnSurfaceError } from "../../src/auth/guard.ts";
import type { StaffSession } from "../../src/auth/context.ts";
import { AI_MODES, ModeInputError, PropertyModeNotFoundError, isAiMode, setAiMode } from "../../src/settings/mode.ts";

const ORG = "11111111-1111-5111-a111-111111111111";
const PROP = "22222222-2222-5222-a222-222222222222";
const USER = "33333333-3333-5333-a333-333333333333";
const CONTEXT = { orgId: ORG, propertyId: PROP };

function harness(options: { allowed?: boolean; rows?: unknown[] } = {}): {
  session: StaffSession;
  client: pg.Client;
  calls: string[];
} {
  const calls: string[] = [];
  const session: StaffSession = {
    userUuid: USER,
    role: options.allowed === false ? "observer" : "manager",
    requireRole: (surface, mode) => {
      if (options.allowed === false) throw new RoleNotOnSurfaceError("observer", surface, mode);
    },
  };
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: options.rows ?? [], rowCount: (options.rows ?? []).length };
    },
  } as unknown as pg.Client;
  return { session, client, calls };
}

describe("AI mode: the closed set", () => {
  it("is exactly the four modes 0001's CHECK allows", () => {
    expect([...AI_MODES]).toEqual(["auto", "draft", "human_only", "after_hours"]);
    for (const mode of AI_MODES) expect(isAiMode(mode)).toBe(true);
    for (const bad of ["AUTO", "off", "", "human only", null, 3]) expect(isAiMode(bad)).toBe(false);
  });
});

describe("AI mode: ordering", () => {
  it("refuses an observer before touching the database", async () => {
    const { session, client, calls } = harness({ allowed: false });
    await expect(setAiMode(client, CONTEXT, session, { mode: "auto" })).rejects.toBeInstanceOf(
      RoleNotOnSurfaceError,
    );
    expect(calls).toEqual([]);
  });

  it("refuses an unknown mode before touching the database", async () => {
    const { session, client, calls } = harness();
    await expect(setAiMode(client, CONTEXT, session, { mode: "yolo" })).rejects.toBeInstanceOf(
      ModeInputError,
    );
    expect(calls).toEqual([]);
  });

  it("reports a missing property rather than inventing a mode", async () => {
    const { session, client } = harness({ rows: [] });
    await expect(setAiMode(client, CONTEXT, session, { mode: "auto" })).rejects.toBeInstanceOf(
      PropertyModeNotFoundError,
    );
  });

  it("does not write when the mode is already set", async () => {
    const { session, client, calls } = harness({ rows: [{ ai_mode: "auto" }] });
    const result = await setAiMode(client, CONTEXT, session, { mode: "auto" });
    expect(result).toEqual({ aiMode: "auto", changed: false, previous: "auto" });
    // One SELECT, no UPDATE, no audit insert.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("FOR UPDATE");
  });
});
