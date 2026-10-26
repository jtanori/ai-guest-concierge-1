/**
 * S07-04 AC-1 — the flood ceiling's arithmetic.
 *
 * The database rows are exercised in `tests/db/abuse.db.test.ts`; this file
 * covers the parts that are pure and therefore cheap to hold to account: the
 * window boundaries, the hashing, and the decision shape the HTTP layer turns
 * into a 429.
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  DEFAULT_IP_SALT,
  RATE_LIMITS,
  checkRate,
  consume,
  hashSubject,
  windowStart,
} from "../../src/security/ratelimit.ts";
import type { TenantContext } from "../../src/db/tenant.ts";

const context: TenantContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  propertyId: "00000000-0000-0000-0000-000000000002",
};

/** A client that returns a scripted sequence of counts. */
function fakeClient(counts: number[]): { query: (sql: string, params?: unknown[]) => Promise<unknown>; calls: unknown[][] } {
  const calls: unknown[][] = [];
  let index = 0;
  return {
    calls,
    async query(_sql: string, params?: unknown[]) {
      calls.push(params ?? []);
      const count = counts[Math.min(index, counts.length - 1)]!;
      index += 1;
      return { rows: [{ count }] };
    },
  } as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown>; calls: unknown[][] };
}

describe("rate limit windows", () => {
  it("aligns windows to the epoch so every replica agrees on the boundary", () => {
    expect(windowStart(new Date("2026-10-25T17:00:00.000Z"), 60).toISOString()).toBe(
      "2026-10-25T17:00:00.000Z",
    );
    expect(windowStart(new Date("2026-10-25T17:00:59.999Z"), 60).toISOString()).toBe(
      "2026-10-25T17:00:00.000Z",
    );
    expect(windowStart(new Date("2026-10-25T17:01:00.000Z"), 60).toISOString()).toBe(
      "2026-10-25T17:01:00.000Z",
    );
    // An hour-long window: the same instant is the top of the hour.
    expect(windowStart(new Date("2026-10-25T17:59:59.000Z"), 3600).toISOString()).toBe(
      "2026-10-25T17:00:00.000Z",
    );
  });

  it("hashes a subject to a stable, opaque key", () => {
    const a = hashSubject("ip", "203.0.113.7");
    expect(a).toBe(hashSubject("ip", "203.0.113.7"));
    expect(a).toHaveLength(32);
    // Never the address itself: the column is readable during an incident.
    expect(a).not.toContain("203.0.113.7");
    // Different subjects, different keys — and the salt is part of the input.
    expect(hashSubject("ip", "203.0.113.8")).not.toBe(a);
    expect(hashSubject("ip", "203.0.113.7", "other-salt")).not.toBe(a);
    expect(hashSubject("conversation", "203.0.113.7")).not.toBe(a);
    expect(DEFAULT_IP_SALT.length).toBeGreaterThan(0);
  });

  it("keeps the three ceilings in a sane order of magnitude", () => {
    // Guards against a typo that would make the limit meaningless: a per-ip
    // limit above the property limit, or anything that a person trips.
    expect(RATE_LIMITS.ip.limit).toBeLessThan(RATE_LIMITS.property.limit);
    expect(RATE_LIMITS.conversation.limit).toBeLessThan(RATE_LIMITS.property.limit);
    expect(RATE_LIMITS.ip.windowSeconds).toBeGreaterThan(0);
    expect(RATE_LIMITS.property.windowSeconds).toBeGreaterThan(RATE_LIMITS.ip.windowSeconds);
  });
});

describe("consume", () => {
  it("returns the count the upsert wrote, not a pre-read", async () => {
    const client = fakeClient([7]);
    const decision = await consume(client as unknown as pg.Client, context, {
      bucket: "conversation",
      key: "conv-1",
      at: new Date("2026-10-25T17:00:10.000Z"),
    });
    expect(decision).toMatchObject({ allowed: true, bucket: "conversation", count: 7 });
    expect(client.calls[0]?.slice(0, 4)).toEqual([
      context.orgId,
      context.propertyId,
      "conversation",
      "conv-1",
    ]);
  });

  it("allows the last request in the window and refuses the next", async () => {
    const at = new Date("2026-10-25T17:00:30.000Z");
    const limit = { limit: 2, windowSeconds: 60 };
    const allowed = await consume(fakeClient([2]) as unknown as pg.Client, context, {
      bucket: "ip",
      key: "h",
      at,
      limit,
    });
    expect(allowed.allowed).toBe(true);

    const refused = await consume(fakeClient([3]) as unknown as pg.Client, context, {
      bucket: "ip",
      key: "h",
      at,
      limit,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(30);
  });
});

describe("checkRate", () => {
  it("consults all three buckets, cheapest first (ip, conversation, property)", async () => {
    const client = fakeClient([1]);
    const verdict = await checkRate(client as unknown as pg.Client, context, {
      ip: "198.51.100.4",
      conversationId: "conv-2",
      at: new Date("2026-10-25T17:00:00.000Z"),
    });
    expect(verdict.decisions.map((decision) => decision.bucket)).toEqual([
      "ip",
      "conversation",
      "property",
    ]);
    expect(verdict.allowed).toBe(true);
    expect(verdict.blocked).toBeNull();
    // The ip bucket stores a hash, never the address.
    expect(client.calls[0]?.[3]).toBe(hashSubject("ip", "198.51.100.4"));
    expect(client.calls[0]?.[3]).not.toBe("198.51.100.4");
  });

  it("skips the ip bucket when there is no address, rather than sharing one bucket", async () => {
    const verdict = await checkRate(fakeClient([1]) as unknown as pg.Client, context, {
      ip: null,
      conversationId: "conv-3",
    });
    expect(verdict.decisions.map((decision) => decision.bucket)).toEqual(["conversation", "property"]);
  });

  it("still consumes the property bucket when the ip bucket refuses", async () => {
    // The operator's dashboard must see the flood, and the tenant ceiling has to
    // tighten even while the flood is being refused.
    const client = fakeClient([RATE_LIMITS.ip.limit + 1, 1, 1]);
    const verdict = await checkRate(client as unknown as pg.Client, context, {
      ip: "198.51.100.9",
      conversationId: "conv-4",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocked?.bucket).toBe("ip");
    expect(client.calls).toHaveLength(3);
  });
});
