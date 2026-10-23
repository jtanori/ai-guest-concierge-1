/**
 * S02-01 — the four-role surface matrix (D1/D3).
 *
 * Roles live in the `roles` table (owner / manager / front_desk / observer,
 * role_id 1-4) and resolve ONLY under RLS from `memberships` — never from
 * the JWT, never from a request body. This module is the single place that
 * maps (role, surface, mode) → permission; routes call `requireRole` and
 * nothing else hand-rolls "can this staff member touch that route".
 *
 * Surface naming follows the plan's staff surfaces:
 *   org       — organization admin: properties, memberships, billing config
 *   knowledge — article authoring/curation (approve, promote, import)
 *   settings  — property settings (languages, tone, hours, topics, caps)
 *   queue     — conversation queue + service requests + manual takeover
 *   analytics — golden metrics, weekly reports (read-only everywhere)
 */
export type Role = "owner" | "manager" | "front_desk" | "observer";
export type Surface = "org" | "knowledge" | "settings" | "queue" | "analytics";
export type Mode = "read" | "write";

export const ROLE_IDS: Record<Role, number> = {
  owner: 1,
  manager: 2,
  front_desk: 3,
  observer: 4,
};

export const ROLE_BY_ID: Record<number, Role> = {
  1: "owner",
  2: "manager",
  3: "front_desk",
  4: "observer",
};

/** The matrix — one object, exhaustively tested in guard.test.ts. */
export const MATRIX: Record<Role, Record<Surface, readonly Mode[]>> = {
  owner: {
    org: ["read", "write"],
    knowledge: ["read", "write"],
    settings: ["read", "write"],
    queue: ["read", "write"],
    analytics: ["read"],
  },
  manager: {
    org: [],
    knowledge: ["read", "write"],
    settings: ["read", "write"],
    queue: ["read", "write"],
    analytics: ["read"],
  },
  front_desk: {
    org: [],
    knowledge: ["read"],
    settings: [],
    queue: ["read", "write"],
    analytics: ["read"],
  },
  observer: {
    org: ["read"],
    knowledge: ["read"],
    settings: ["read"],
    queue: ["read"],
    analytics: ["read"],
  },
};

export class RoleNotOnSurfaceError extends Error {
  constructor(role: Role, surface: Surface, mode: Mode) {
    super(`role ${role} has no ${mode} access to the ${surface} surface`);
    this.name = "RoleNotOnSurfaceError";
  }
}

export function can(role: Role, surface: Surface, mode: Mode): boolean {
  return MATRIX[role][surface].includes(mode);
}

/** Throwing variant for route guards. */
export function requireRole(role: Role, surface: Surface, mode: Mode): void {
  if (!can(role, surface, mode)) throw new RoleNotOnSurfaceError(role, surface, mode);
}
