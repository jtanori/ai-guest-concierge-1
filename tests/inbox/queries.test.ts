/**
 * S08-01 — the pure half of the inbox.
 *
 * The database cases live in `tests/db/inbox.db.test.ts`; what is asserted here
 * is everything that can be wrong without a cluster: the filter set, the page
 * size, the cursor codec, and the fact that authorisation runs *before* the
 * query rather than after it.
 */
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { StaffSession } from "../../src/auth/context.ts";
import { RoleNotOnSurfaceError } from "../../src/auth/guard.ts";
import {
  DEFAULT_INBOX_FILTER,
  INBOX_FILTERS,
  INBOX_PAGE_DEFAULT,
  INBOX_PAGE_MAX,
  INBOX_PAGE_SQL,
  InboxInputError,
  decodeCursor,
  encodeCursor,
  listInbox,
  parseFilter,
  parseLimit,
} from "../../src/inbox/queries.ts";

const ORG = "11111111-1111-5111-a111-111111111111";
const PROP = "22222222-2222-5222-a222-222222222222";
const USER = "33333333-3333-5333-a333-333333333333";
const CONV = "44444444-4444-5444-a444-444444444444";

/** A session whose requireRole either passes or throws, and a client that counts. */
function harness(options: { allowed?: boolean } = {}): {
  session: StaffSession;
  client: pg.Client;
  calls: { sql: string; values: unknown[] }[];
} {
  const calls: { sql: string; values: unknown[] }[] = [];
  const session: StaffSession = {
    userUuid: USER,
    role: "front_desk",
    requireRole: (surface, mode) => {
      if (options.allowed === false) throw new RoleNotOnSurfaceError("observer", surface, mode);
    },
  };
  const client = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Client;
  return { session, client, calls };
}

describe("inbox: filter and page size (S08-01)", () => {
  it("defaults to needs-attention — the only queue where doing nothing costs", () => {
    expect(DEFAULT_INBOX_FILTER).toBe("needs_attention");
    expect(parseFilter(null)).toBe("needs_attention");
    expect(parseFilter("")).toBe("needs_attention");
    expect(parseFilter(undefined)).toBe("needs_attention");
  });

  it("accepts exactly the closed set", () => {
    for (const filter of INBOX_FILTERS) expect(parseFilter(filter)).toBe(filter);
  });

  it("refuses an unknown filter instead of silently serving a different queue", () => {
    // The dangerous failure is not a 400, it is an agent who asks for "mine",
    // gets needs-attention, and believes they have read their own queue.
    for (const bad of ["MINE", "needs-attention", "all", " unresolved"]) {
      expect(() => parseFilter(bad)).toThrow(InboxInputError);
    }
  });

  it("pages 20 by default and clamps greedy clients", () => {
    expect(parseLimit(null)).toBe(INBOX_PAGE_DEFAULT);
    expect(parseLimit("5")).toBe(5);
    expect(parseLimit(5)).toBe(5);
    expect(parseLimit("500")).toBe(INBOX_PAGE_MAX);
    for (const bad of ["0", "-1", "2.5", "ten"]) expect(() => parseLimit(bad)).toThrow(InboxInputError);
  });
});

describe("inbox: cursor codec (S08-01)", () => {
  it("round-trips the keyset pair", () => {
    const cursor = { at: "2026-10-26T07:00:00.000Z", id: CONV };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("is opaque: base64url of JSON, not a readable offset", () => {
    const encoded = encodeCursor({ at: "2026-10-26T07:00:00.000Z", id: CONV });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("2026");
  });

  it("treats empty as 'first page'", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("refuses a hand-edited cursor rather than paging from a random place", () => {
    expect(() => decodeCursor("not base64 json")).toThrow(InboxInputError);
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ at: "yesterday", id: CONV })).toString("base64url")),
    ).toThrow(InboxInputError);
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ at: "2026-10-26T07:00:00Z", id: "nope" })).toString("base64url")),
    ).toThrow(InboxInputError);
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify(["2026-10-26T07:00:00Z", CONV])).toString("base64url")),
    ).toThrow(InboxInputError);
  });
});

describe("inbox: the query is a read (S08-01)", () => {
  it("has no write clause and no LLM/embedding call", () => {
    const sql = INBOX_PAGE_SQL.toLowerCase();
    for (const forbidden of ["insert into", "update ", "delete from", "embedding", "provider"]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it("carries the tenant predicate explicitly, for every table it joins", () => {
    // RLS already scopes these; the explicit predicates are what make a missing
    // join condition a test failure instead of a leak.
    expect(INBOX_PAGE_SQL).toContain("c.org_id = $1");
    expect(INBOX_PAGE_SQL).toContain("c.property_id = $2");
    // five: the three LATERAL joins plus both EXISTS filters
    expect(INBOX_PAGE_SQL.match(/property_id = c\.property_id/g)?.length).toBe(5);
  });

  it("orders and pages on the same key, so a page boundary cannot repeat a row", () => {
    expect(INBOX_PAGE_SQL).toContain("ORDER BY c.last_activity_at DESC, c.conversation_id DESC");
    expect(INBOX_PAGE_SQL).toContain("(c.last_activity_at, c.conversation_id) < ($5::timestamptz, $6::uuid)");
  });
});

describe("inbox: authorisation runs first (S08-01)", () => {
  it("passes the filter, the tenant and the caller to the statement", async () => {
    const { client, session, calls } = harness();
    await listInbox(client, { orgId: ORG, propertyId: PROP }, session, {
      filter: "mine",
      limit: 5,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values.slice(0, 4)).toEqual([ORG, PROP, "mine", USER]);
    // limit + 1: the extra row is how "there is a next page" is answered
    // without counting the property's whole history.
    expect(calls[0]!.values[6]).toBe(6);
  });

  it("asks the database for nothing when the role is refused", async () => {
    const { client, session, calls } = harness({ allowed: false });
    await expect(
      listInbox(client, { orgId: ORG, propertyId: PROP }, session, {}),
    ).rejects.toThrow(RoleNotOnSurfaceError);
    expect(calls).toHaveLength(0);
  });

  it("refuses an invalid page before it becomes a query", async () => {
    const { client, session, calls } = harness();
    await expect(
      listInbox(client, { orgId: ORG, propertyId: PROP }, session, { filter: "nope" }),
    ).rejects.toThrow(InboxInputError);
    expect(calls).toHaveLength(0);
  });
});
