import { describe, expect, it, vi } from "vitest";
import { canTransitionRequest, REQUEST_STATUSES, transitionRequest } from "../../src/requests/lifecycle.ts";
import type pg from "pg";
import type { StaffSession } from "../../src/auth/context.ts";

describe("request lifecycle", () => {
  const edges = new Set(["new:acknowledged", "acknowledged:assigned", "assigned:resolved", "assigned:cancelled"]);
  for (const from of REQUEST_STATUSES) {
    for (const to of REQUEST_STATUSES) {
      it(`${from} → ${to}`, () => {
        expect(canTransitionRequest(from, to)).toBe(from === to || edges.has(`${from}:${to}`));
      });
    }
  }
  it("denies before issuing SQL", async () => {
    const query = vi.fn();
    const session = { requireRole: () => { throw new Error("denied"); } } as unknown as StaffSession;
    await expect(transitionRequest({ query } as unknown as pg.Client,
      { orgId: "00000000-0000-4000-8000-000000000001", propertyId: "00000000-0000-4000-8000-000000000002" },
      session, "00000000-0000-4000-8000-000000000003", "acknowledged",
    )).rejects.toThrow("denied");
    expect(query).not.toHaveBeenCalled();
  });
});
