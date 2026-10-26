/**
 * S09-02 — the knowledge-gap queue, against a real database.
 *
 * AC-1 is "every no_answer lands in the queue automatically", so the primary
 * assertions here drive a **real guest turn** through `postGuestMessage` against
 * a property with nothing to cite, and then look at the rows. A test that called
 * `recordGap` directly would prove the function works and not that the pipeline
 * calls it — and "automatically" is the whole AC.
 *
 * The property is seeded with no articles on purpose: an empty retrieval is one
 * of the two no-answer paths, and it needs no model output to reach, so the
 * provider is a stub that is never consulted.
 *
 * AC-2's two halves are separate: closing emits `knowledge_gap_closed`, and the
 * median age of what is still open is computable. The median gets its own case
 * with hand-set `created_at` values, because a median over rows all created in
 * the same millisecond is a number that cannot be wrong.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ecKey, liveClaims, mint, TEST_VERIFY } from "../auth/fixtures.ts";
import { verifyWithJwk, type StaffIdentity } from "../../src/auth/session.ts";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { handleGapsRequest, type ReviewHttpDeps } from "../../src/staff/http.ts";
import { postGuestMessage, type GuestDeps } from "../../src/guest/service.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/schema.ts";
import { connectScratch, dropScratch, recreateScratch } from "./helpers.db.ts";

const KEY = ecKey("gaps-key");
const SECRET = "g".repeat(40);
const SLUG_A = "casa-hueca";
const SLUG_B = "hotel-ajeno";

interface Person {
  email: string;
  neon: string;
  roleId: number;
  userUuid: string;
  token: string;
}

function person(key: string, roleId: number, tenantKey: string): Person {
  const email = `${key}@${tenantKey}.mx`;
  return {
    email,
    neon: `auth|gaps-${key}`,
    roleId,
    userUuid: "",
    token: mint(KEY, liveClaims({ sub: `auth|gaps-${key}`, email, name: key })),
  };
}

// role_id 1 owner, 2 manager, 3 front_desk, 4 observer (0001)
const OWNER = person("owner", 1, "a");
const MANAGER = person("manager", 2, "a");
const DESK = person("desk", 3, "a");
const OBSERVER = person("observer", 4, "a");
const OWNER_B = person("owner_b", 1, "b");

let client: pg.Client;
let tenantA: { orgId: string; propertyId: string };
let tenantB: { orgId: string; propertyId: string };

function identityFor(token: string): StaffIdentity {
  return verifyWithJwk(token, KEY.jwk as never, TEST_VERIFY);
}

/** Nothing to cite, so every question on these properties is a no-answer. */
function guestDeps(): GuestDeps {
  return {
    ai: withResilience(
      createFixedProvider({}, "stub-gaps-primary-2026-01-01"),
      createFixedProvider({}, "stub-gaps-fallback-2026-01-01"),
      { retries: 0, sleep: async () => {}, now: () => 0 },
    ),
    cookieSecret: SECRET,
    now: () => new Date("2026-10-26T15:00:00Z"),
  };
}

async function provision(member: Person, propertyId: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE concierge_app");
    const user = await client.query<{ user_id: string }>(
      "SELECT provision_user($1, $2, $3) AS user_id",
      [member.neon, member.email, member.email],
    );
    member.userUuid = user.rows[0]!.user_id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  await client.query("INSERT INTO memberships (user_id, property_id, role_id) VALUES ($1, $2, $3)", [
    member.userUuid,
    propertyId,
    member.roleId,
  ]);
}

/** One real guest turn, and therefore one real no-answer. */
async function ask(text: string, options: { slug?: string; language?: string } = {}) {
  return postGuestMessage(guestDeps(), client, {
    slug: options.slug ?? SLUG_A,
    text,
    language: options.language ?? "es",
  });
}

interface GapRow {
  gap_id: string;
  question: string;
  language: string | null;
  hits: number;
  status: string;
  resolved_at: Date | null;
  conversation_id: string | null;
}

async function gapsFor(propertyId: string): Promise<GapRow[]> {
  const rows = await client.query<GapRow>(
    `SELECT gap_id, question, language, hits, status, resolved_at, conversation_id
       FROM knowledge_gaps WHERE property_id = $1 ORDER BY created_at, gap_id`,
    [propertyId],
  );
  return rows.rows;
}

async function eventsOfType(type: string, propertyId: string): Promise<number> {
  const rows = await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM events WHERE property_id = $1 AND event_type = $2",
    [propertyId, type],
  );
  return Number(rows.rows[0]!.n);
}

/* ------------------------------- HTTP layer ------------------------------- */

function fakeReq(options: {
  method?: string;
  url: string;
  token?: string;
  context?: { orgId: string; propertyId: string };
}): IncomingMessage {
  const headers: Record<string, string> = { host: "gaps.test" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.context !== undefined) {
    headers["x-org-id"] = options.context.orgId;
    headers["x-property-id"] = options.context.propertyId;
  }
  return {
    method: options.method ?? "GET",
    url: options.url,
    headers,
    async *[Symbol.asyncIterator]() {},
  } as unknown as IncomingMessage;
}

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

async function call(options: {
  method?: string;
  url: string;
  token: string;
  context?: { orgId: string; propertyId: string };
}): Promise<Captured> {
  const captured: Captured = { status: 0, body: {} };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    setHeader() {},
    end(chunk?: unknown) {
      if (typeof chunk === "string" && chunk.length > 0) {
        captured.body = JSON.parse(chunk) as Record<string, unknown>;
      }
    },
  } as unknown as ServerResponse;
  const deps: ReviewHttpDeps = { client, verifyToken: async (token: string) => identityFor(token) };
  await handleGapsRequest(
    fakeReq({ ...options, context: options.context ?? tenantA }),
    res,
    deps,
  );
  return captured;
}

const queue = (token: string, url = "/api/gaps", context?: { orgId: string; propertyId: string }) =>
  call({ url, token, context });
const close = (gapId: string, token: string, context?: { orgId: string; propertyId: string }) =>
  call({ method: "POST", url: `/api/gaps/${gapId}/close`, token, context });

/* --------------------------------- suite --------------------------------- */

describe("knowledge-gap queue (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();

    for (const [name, slug] of [
      ["Casa Hueca", SLUG_A],
      ["Hotel Ajeno", SLUG_B],
    ] as const) {
      const org = await client.query<{ org_id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING org_id",
        [`org_${slug}`],
      );
      const property = await client.query<{ property_id: string }>(
        `INSERT INTO properties (org_id, name, slug, time_zone, settings)
         VALUES ($1, $2, $3, 'America/Mexico_City', $4::jsonb) RETURNING property_id`,
        [org.rows[0]!.org_id, name, slug, JSON.stringify(DEFAULT_SETTINGS)],
      );
      const tenant = { orgId: org.rows[0]!.org_id, propertyId: property.rows[0]!.property_id };
      if (slug === SLUG_A) tenantA = tenant;
      else tenantB = tenant;
    }

    for (const member of [OWNER, MANAGER, DESK, OBSERVER]) await provision(member, tenantA.propertyId);
    await provision(OWNER_B, tenantB.propertyId);
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  describe("AC-1 — every no_answer lands in the queue automatically", () => {
    it("records the verbatim question, the language and the property", async () => {
      const question = "¿Tienen toallas extra en la habitación?";
      const turn = await ask(question);
      expect(turn.decision).toBe("no_answer");

      const rows = await gapsFor(tenantA.propertyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        gap_id: expect.any(String),
        // Verbatim: accents, opening question mark and all. The content owner is
        // reading what the guest typed, not a normalised form of it.
        question,
        language: "es",
        hits: 1,
        status: "open",
        conversation_id: turn.conversationId,
      });
      expect(await eventsOfType("knowledge_gap_created", tenantA.propertyId)).toBe(1);
    });

    it("counts a repeat as a hit on the same row, not as a second queue entry", async () => {
      const before = await gapsFor(tenantA.propertyId);
      const createdEvents = await eventsOfType("knowledge_gap_created", tenantA.propertyId);

      // A different guest, so a different conversation: the case the old
      // per-conversation dedupe missed entirely.
      await ask("¿A qué hora es el desayuno?");
      await ask("¿A qué hora es el desayuno?");

      const after = await gapsFor(tenantA.propertyId);
      expect(after).toHaveLength(before.length + 1);
      const breakfast = after.filter((row) => row.question === "¿A qué hora es el desayuno?");
      expect(breakfast).toHaveLength(1);
      expect(breakfast[0]!.hits).toBe(2);
      // One entry joined the queue; the second ask is a count, not an event.
      expect(await eventsOfType("knowledge_gap_created", tenantA.propertyId)).toBe(createdEvents + 1);
    });

    it("counts one ask per turn, not one per writer", async () => {
      // A single no-answer turn reaches recordGap twice: the pipeline records the
      // miss, then the request capture links the escalation to it. Both are inside
      // the one guest transaction. If hits counted calls instead of turns, every
      // gap in the queue would read exactly double the guests who asked.
      const rowsBefore = await gapsFor(tenantA.propertyId);
      await ask("¿Hay servicio de lavandería?");
      const rows = (await gapsFor(tenantA.propertyId)).filter(
        (row) => !rowsBefore.some((prior) => prior.gap_id === row.gap_id),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.hits).toBe(1);

      // And the request that promised a human points at that same gap.
      const linked = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM service_requests
          WHERE property_id = $1 AND topic = 'unanswered_question'`,
        [tenantA.propertyId],
      );
      expect(Number(linked.rows[0]!.n)).toBeGreaterThanOrEqual(1);
    });

    it("treats case and surrounding whitespace as the same question", async () => {
      await ask("¿Hay gimnasio?");
      await ask("¿HAY GIMNASIO?");
      const rows = (await gapsFor(tenantA.propertyId)).filter((row) =>
        row.question.toLowerCase().includes("gimnasio"),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.hits).toBe(2);
    });

    it("folds accented capitals, which plain lower() does not on a C collation", async () => {
      // On a database initialised with the C/POSIX collation, lower() folds ASCII
      // only: lower('¿DÓNDE') is '¿dÓnde'. So a question shouted in capitals would
      // open a SECOND queue entry next to the same question asked normally — on one
      // deployment and not another, depending on a locale flag nobody thinks about.
      // For a product whose working language is Spanish that is the common case.
      //
      // question_key runs the capitals through translate() first, so this passes in
      // every collation. The assertion is the guard against somebody tidying the
      // generated column back to plain lower(), which looks equivalent and is not.
      await ask("¿Dónde está el cajero más cercano?");
      await ask("¿dónde está el cajero más cercano?");
      await ask("  ¿DÓNDE ESTÁ EL CAJERO MÁS CERCANO?  ");
      const rows = (await gapsFor(tenantA.propertyId)).filter((row) =>
        row.question.toLowerCase().includes("cajero"),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.hits).toBe(3);
      // The stored question is the first sighting, verbatim — the fold is for
      // matching only, never for what a human reads.
      expect(rows[0]!.question).toBe("¿Dónde está el cajero más cercano?");
    });

    it("records a question far longer than a btree key can hold", async () => {
      // 1,600 two-byte characters is ~3,200 bytes, over the ~2,704-byte limit on
      // a btree index key. Indexing lower(question) directly would make this
      // INSERT fail — a guest who writes a long question would break their own
      // reply. The generated question_key caps at 400 characters instead.
      const long = "ñ".repeat(1_600);
      const turn = await ask(long);
      expect(turn.decision).toBe("no_answer");

      const rows = (await gapsFor(tenantA.propertyId)).filter((row) => row.question === long);
      expect(rows).toHaveLength(1);
      // The question is stored whole; only the matching key is truncated.
      expect(rows[0]!.question).toHaveLength(1_600);
    });

    it("keeps two properties' identical questions apart", async () => {
      const question = "¿El wifi es gratis?";
      await ask(question);
      await ask(question, { slug: SLUG_B });
      const a = (await gapsFor(tenantA.propertyId)).filter((row) => row.question === question);
      const b = (await gapsFor(tenantB.propertyId)).filter((row) => row.question === question);
      // The dedupe key includes property_id, so the same words at two hotels are
      // two entries for two content owners — merging them would tell one hotel
      // that the other had answered.
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]!.gap_id).not.toBe(b[0]!.gap_id);
    });

    it("lets a resolved question be recorded again as new work", async () => {
      const question = "¿Aceptan mascotas?";
      await ask(question);
      const gap = (await gapsFor(tenantA.propertyId)).find((row) => row.question === question)!;
      await close(gap.gap_id, MANAGER.token);

      // "We wrote the article and they are still asking" is a different fact from
      // "we never answered", so the partial index (WHERE status = 'open') lets the
      // same question open a fresh entry rather than resurrecting a closed one.
      await ask(question);
      const rows = (await gapsFor(tenantA.propertyId)).filter((row) => row.question === question);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.status).sort()).toEqual(["open", "resolved"]);
      expect(rows.find((row) => row.status === "open")!.hits).toBe(1);
    });
  });

  describe("AC-2 — closing emits, and the median age is computable", () => {
    it("closes a gap, emits knowledge_gap_closed and audits it", async () => {
      await ask("¿Dónde queda la playa más cercana?");
      const gap = (await gapsFor(tenantA.propertyId)).find((row) =>
        row.question.includes("playa más cercana"),
      )!;

      const closed = await close(gap.gap_id, OWNER.token);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ gapId: gap.gap_id, changed: true });
      expect(typeof closed.body["openAgeDays"]).toBe("number");

      const row = (await gapsFor(tenantA.propertyId)).find((r) => r.gap_id === gap.gap_id)!;
      expect(row.status).toBe("resolved");
      expect(row.resolved_at).not.toBeNull();

      const events = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM events
          WHERE property_id = $1 AND event_type = 'knowledge_gap_closed'
            AND payload->>'gap_id' = $2`,
        [tenantA.propertyId, gap.gap_id],
      );
      expect(events.rowCount).toBe(1);
      expect(events.rows[0]!.payload).toMatchObject({
        gap_id: gap.gap_id,
        actor_user_id: OWNER.userUuid,
      });

      const audit = await client.query<{ action: string; actor_user_id: string }>(
        `SELECT action, actor_user_id FROM audit_log
          WHERE entity_type = 'knowledge_gap' AND entity_id = $1`,
        [gap.gap_id],
      );
      expect(audit.rows).toEqual([{ action: "knowledge_gap.closed", actor_user_id: OWNER.userUuid }]);
    });

    it("a second close is a no-op that writes nothing again", async () => {
      // A question with no booking intent in it: "¿tienen cunas disponibles?"
      // is classified booking_intent and escalates instead, which records a
      // request and correctly records no gap — there was nothing to look up.
      await ask("¿Qué museos hay cerca del hotel?");
      const gap = (await gapsFor(tenantA.propertyId)).find((row) =>
        row.question.includes("museos"),
      )!;
      expect((await close(gap.gap_id, MANAGER.token)).body).toMatchObject({ changed: true });

      const replay = await close(gap.gap_id, MANAGER.token);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ gapId: gap.gap_id, changed: false });

      const events = await client.query(
        `SELECT 1 FROM events WHERE property_id = $1 AND event_type = 'knowledge_gap_closed'
           AND payload->>'gap_id' = $2`,
        [tenantA.propertyId, gap.gap_id],
      );
      expect(events.rowCount).toBe(1);
      const audit = await client.query(
        "SELECT 1 FROM audit_log WHERE entity_type = 'knowledge_gap' AND entity_id = $1",
        [gap.gap_id],
      );
      expect(audit.rowCount).toBe(1);
    });

    it("computes the median age of what is open, not a mean and not a page", async () => {
      // A private property so the median is not diluted by the gaps above.
      const org = await client.query<{ org_id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('org_median', 'org_median') RETURNING org_id",
      );
      const property = await client.query<{ property_id: string }>(
        `INSERT INTO properties (org_id, name, slug, time_zone, settings)
         VALUES ($1, 'Median Hotel', 'median-hotel', 'UTC', $2::jsonb) RETURNING property_id`,
        [org.rows[0]!.org_id, JSON.stringify(DEFAULT_SETTINGS)],
      );
      const medianTenant = { orgId: org.rows[0]!.org_id, propertyId: property.rows[0]!.property_id };
      const member = person("median_owner", 1, "median");
      await provision(member, medianTenant.propertyId);

      // Ages 1, 3, 21 days open, plus one closed row that must not be counted.
      // A mean of the open three would be 8.33; the median is 3 — the difference
      // is the one gap nobody has touched since launch, which is exactly why
      // Appendix D's target is a median.
      for (const [age, status] of [
        [1, "open"],
        [3, "open"],
        [21, "open"],
        [90, "resolved"],
      ] as const) {
        await client.query(
          `INSERT INTO knowledge_gaps
             (org_id, property_id, question, language, status, hits, created_at, resolved_at)
           VALUES ($1, $2, $3, 'es', $4, 1, now() - ($5 || ' days')::interval,
                   CASE WHEN $4 = 'resolved' THEN now() ELSE NULL END)`,
          [medianTenant.orgId, medianTenant.propertyId, `pregunta ${age}`, status, String(age)],
        );
      }

      const page = await queue(member.token, "/api/gaps", medianTenant);
      expect(page.status).toBe(200);
      expect(page.body["openCount"]).toBe(3);
      expect(Number(page.body["medianOpenAgeDays"])).toBeCloseTo(3, 1);
      // The queue is oldest-first: the thing that has waited longest is on top.
      const questions = (page.body["items"] as Array<{ question: string }>).map((i) => i.question);
      expect(questions).toEqual(["pregunta 21", "pregunta 3", "pregunta 1"]);
    });

    it("reports no median when nothing is open, rather than zero", async () => {
      const org = await client.query<{ org_id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('org_empty', 'org_empty') RETURNING org_id",
      );
      const property = await client.query<{ property_id: string }>(
        `INSERT INTO properties (org_id, name, slug, time_zone, settings)
         VALUES ($1, 'Empty Hotel', 'empty-hotel', 'UTC', $2::jsonb) RETURNING property_id`,
        [org.rows[0]!.org_id, JSON.stringify(DEFAULT_SETTINGS)],
      );
      const empty = { orgId: org.rows[0]!.org_id, propertyId: property.rows[0]!.property_id };
      const member = person("empty_owner", 1, "empty");
      await provision(member, empty.propertyId);

      const page = await queue(member.token, "/api/gaps", empty);
      expect(page.body["items"]).toEqual([]);
      expect(page.body["openCount"]).toBe(0);
      // Zero would read as "nothing is waiting", which is true, but also as a
      // measurement — and there was nothing to measure.
      expect(page.body["medianOpenAgeDays"]).toBeNull();
      expect(page.body["nextCursor"]).toBeNull();
    });
  });

  describe("who may work the queue", () => {
    it("lets a front desk read it but not close it", async () => {
      await ask("¿Hay transporte al aeropuerto?");
      const gap = (await gapsFor(tenantA.propertyId)).find((row) =>
        row.question.includes("aeropuerto"),
      )!;

      // `knowledge: read` for front_desk, `knowledge: write` for owner/manager —
      // closing is a claim that the content now exists, which is not the front
      // desk's claim to make.
      expect((await queue(DESK.token)).status).toBe(200);
      const denied = await close(gap.gap_id, DESK.token);
      expect(denied.status).toBe(403);
      expect(denied.body["error"]).toBe("role_not_on_surface");

      const row = (await gapsFor(tenantA.propertyId)).find((r) => r.gap_id === gap.gap_id)!;
      expect(row.status).toBe("open");
    });

    it("lets an observer read it and nothing else", async () => {
      expect((await queue(OBSERVER.token)).status).toBe(200);
      const gap = (await gapsFor(tenantA.propertyId))[0]!;
      expect((await close(gap.gap_id, OBSERVER.token)).status).toBe(403);
    });

    it("is 401 without a token", async () => {
      const anonymous = await call({ url: "/api/gaps", token: "" });
      expect(anonymous.status).toBe(401);
    });

    it("answers 405, not 404, on a known path with the wrong method", async () => {
      const wrong = await call({ method: "POST", url: "/api/gaps", token: OWNER.token });
      expect(wrong.status).toBe(405);
    });
  });

  describe("tenancy", () => {
    it("never shows one property another's queue, even to a valid owner", async () => {
      const a = await queue(OWNER.token);
      const b = await queue(OWNER_B.token, "/api/gaps", tenantB);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const aIds = new Set((a.body["items"] as Array<{ gapId: string }>).map((i) => i.gapId));
      const bIds = new Set((b.body["items"] as Array<{ gapId: string }>).map((i) => i.gapId));
      expect(aIds.size).toBeGreaterThan(0);
      expect(bIds.size).toBeGreaterThan(0);
      for (const id of bIds) expect(aIds.has(id)).toBe(false);
      for (const id of aIds) expect(bIds.has(id)).toBe(false);
    });

    it("answers 404 for another tenant's gap, never 403", async () => {
      const foreign = (await gapsFor(tenantB.propertyId))[0]!;
      // A correctly-shaped id belonging to somebody else. 403 would confirm the id
      // is real; 404 makes it indistinguishable from one that never existed.
      const denied = await close(foreign.gap_id, OWNER.token);
      expect(denied.status).toBe(404);
      const row = (await gapsFor(tenantB.propertyId)).find((r) => r.gap_id === foreign.gap_id)!;
      expect(row.status).toBe("open");
    });

    it("answers 404 for a gap that does not exist", async () => {
      const missing = await close("00000000-0000-4000-8000-000000000009", OWNER.token);
      expect(missing.status).toBe(404);
      expect(missing.body["error"]).toBe("not_found");
    });
  });

  describe("paging", () => {
    it("pages by keyset and does not repeat a row across the boundary", async () => {
      const org = await client.query<{ org_id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('org_pages', 'org_pages') RETURNING org_id",
      );
      const property = await client.query<{ property_id: string }>(
        `INSERT INTO properties (org_id, name, slug, time_zone, settings)
         VALUES ($1, 'Paged Hotel', 'paged-hotel', 'UTC', $2::jsonb) RETURNING property_id`,
        [org.rows[0]!.org_id, JSON.stringify(DEFAULT_SETTINGS)],
      );
      const paged = { orgId: org.rows[0]!.org_id, propertyId: property.rows[0]!.property_id };
      const member = person("paged_owner", 1, "paged");
      await provision(member, paged.propertyId);

      for (let i = 0; i < 5; i += 1) {
        await client.query(
          `INSERT INTO knowledge_gaps (org_id, property_id, question, status, hits, created_at)
           VALUES ($1, $2, $3, 'open', 1, now() - ($4 || ' hours')::interval)`,
          [paged.orgId, paged.propertyId, `pregunta ${i}`, String(i)],
        );
      }

      const first = await queue(member.token, "/api/gaps?limit=2", paged);
      const firstItems = first.body["items"] as Array<{ gapId: string }>;
      expect(firstItems).toHaveLength(2);
      expect(typeof first.body["nextCursor"]).toBe("string");

      const second = await queue(
        member.token,
        `/api/gaps?limit=2&cursor=${encodeURIComponent(String(first.body["nextCursor"]))}`,
        paged,
      );
      const secondItems = second.body["items"] as Array<{ gapId: string }>;
      expect(secondItems).toHaveLength(2);
      // Disjoint, and continuing oldest-first.
      expect(secondItems.map((i) => i.gapId).filter((id) => firstItems.some((f) => f.gapId === id)))
        .toEqual([]);

      const third = await queue(
        member.token,
        `/api/gaps?limit=2&cursor=${encodeURIComponent(String(second.body["nextCursor"]))}`,
        paged,
      );
      expect((third.body["items"] as unknown[]).length).toBe(1);
      expect(third.body["nextCursor"]).toBeNull();
    });

    it("refuses a hand-edited cursor instead of guessing", async () => {
      const bad = await queue(OWNER.token, "/api/gaps?cursor=not-base64url-json");
      expect(bad.status).toBe(400);
      expect(bad.body["error"]).toBe("invalid_request");
    });
  });
});
