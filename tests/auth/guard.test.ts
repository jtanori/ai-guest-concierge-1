import { describe, expect, it } from "vitest";
import { can, MATRIX, requireRole, RoleNotOnSurfaceError, ROLE_BY_ID, ROLE_IDS, type Mode, type Role, type Surface } from "../../src/auth/guard.ts";

const ROLES = Object.keys(MATRIX) as Role[];
const SURFACES = ["org", "knowledge", "settings", "queue", "analytics"] as Surface[];
const MODES = ["read", "write"] as Mode[];

describe("four-role surface matrix (S02-01)", () => {
  it("covers exactly the four plan roles and every surface × mode cell", () => {
    expect(ROLES).toEqual(["owner", "manager", "front_desk", "observer"]);
    for (const role of ROLES) {
      expect(Object.keys(MATRIX[role]).sort()).toEqual([...SURFACES].sort());
      const modes = new Set(MODES);
      for (const surface of SURFACES) {
        for (const cell of MATRIX[role][surface]) {
          expect(modes, `${role}/${surface} cell ${cell}`).toContain(cell);
        }
      }
    }
    expect(Object.entries(ROLE_IDS).map(([name, id]) => `${id}:${name}`)).toEqual([
      "1:owner", "2:manager", "3:front_desk", "4:observer",
    ]);
    expect(ROLE_BY_ID[4]).toBe("observer");
  });

  it("grants are monotone: no role holds a mode+surface the owner lacks", () => {
    for (const role of ROLES.filter((r) => r !== "owner")) {
      for (const surface of SURFACES) {
        for (const mode of MODES) {
          if (can(role, surface, mode) && !can("owner", surface, mode)) {
            throw new Error(`${role} holds ${surface}/${mode} but owner does not`);
          }
        }
      }
    }
  });

  it("manager writes knowledge and settings but cannot touch org admin", () => {
    expect(can("manager", "knowledge", "write")).toBe(true);
    expect(can("manager", "settings", "write")).toBe(true);
    expect(can("manager", "org", "read")).toBe(false);
    expect(can("manager", "org", "write")).toBe(false);
  });

  it("front_desk works the queue, reads knowledge, and has no settings", () => {
    expect(can("front_desk", "queue", "write")).toBe(true);
    expect(can("front_desk", "knowledge", "read")).toBe(true);
    expect(can("front_desk", "knowledge", "write")).toBe(false);
    expect(can("front_desk", "settings", "read")).toBe(false);
    expect(can("front_desk", "org", "read")).toBe(false);
  });

  it("observer is read-only everywhere", () => {
    for (const surface of SURFACES) {
      expect(can("observer", surface, "read"), `observer reads ${surface}`).toBe(true);
      expect(can("observer", surface, "write"), `observer writes ${surface}`).toBe(false);
    }
  });

  it("requireRole throws with a named, greppable error on refusal", () => {
    expect(() => requireRole("observer", "analytics", "read")).not.toThrow();
    expect(() => requireRole("front_desk", "settings", "read")).toThrow(new RoleNotOnSurfaceError("front_desk", "settings", "read").message);
    expect(() => requireRole("manager", "org", "write")).toThrow(RoleNotOnSurfaceError);
    const caught = (() => {
      try {
        requireRole("manager", "org", "write");
      } catch (error) {
        return error as RoleNotOnSurfaceError;
      }
    })()!;
    expect(caught.name).toBe("RoleNotOnSurfaceError");
    expect(caught.message).toMatch(/manager has no write access to the org surface/);
  });
});
