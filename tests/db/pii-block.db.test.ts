/**
 * S11-03 / AC-1 — a card in a guest's message is refused before anything is written.
 *
 * The decisive assertion is the **absence** of rows: not "the body was masked" but
 * "there is no message, no conversation and no event for this turn", checked by
 * counting the tables before and after. That is what "refused in chat and never
 * logged" has to mean if it is going to survive a future `log.debug(text)`.
 *
 * The fixture's card is `4242 4242 4242 4242` — synthetic, Luhn-valid, and the only
 * kind of card number this repository may contain (AC-3).
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CardNumberRefusedError, postGuestMessage, type GuestDeps } from "../../src/guest/service.ts";
import { classifyGuestError } from "../../src/guest/http.ts";
import { counterTotal, resetCounters } from "../../src/metrics/counters.ts";
import { withResilience } from "../../src/ai/provider.ts";
import { createFixedProvider } from "../../src/ai/stub.ts";
import { connectScratch, dropScratch, recreateScratch, seedTenant } from "./helpers.db.ts";

const CARD = "4242 4242 4242 4242";
const SLUG = "pii-hotel";

let client: pg.Client;
let orgId = "";
let propertyId = "";

function deps(): GuestDeps {
  // The model must never be reached on this path. A fixed provider would answer if
  // the refusal happened late, so the test would still pass on the day somebody moved
  // the check below `withGuestSession` — hence the row counts below, not this.
  const answer = { decision: "no_answer" as const, reason_code: "low_retrieval" as const };
  return {
    ai: withResilience(
      createFixedProvider(answer, "stub-primary-2026-01-01"),
      createFixedProvider(answer, "stub-fallback-2026-01-01"),
      { retries: 0, sleep: async () => {}, now: () => 0 },
    ),
    cookieSecret: "c".repeat(40),
    now: () => new Date("2026-10-25T17:00:00Z"),
  };
}

async function counts(): Promise<{ conversations: number; messages: number; events: number }> {
  const result = await client.query<{ conversations: string; messages: string; events: string }>(
    `SELECT (SELECT count(*) FROM conversations)::text AS conversations,
            (SELECT count(*) FROM messages)::text AS messages,
            (SELECT count(*) FROM events)::text AS events`,
  );
  const row = result.rows[0]!;
  return {
    conversations: Number(row.conversations),
    messages: Number(row.messages),
    events: Number(row.events),
  };
}

describe("card-like input is refused (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    client = await connectScratch();
    const seeded = await seedTenant(client, "pii");
    orgId = seeded.orgId;
    propertyId = seeded.propertyId;
    await client.query("UPDATE properties SET slug = $2 WHERE property_id = $1", [propertyId, SLUG]);
  });

  afterAll(async () => {
    await client.end();
    await dropScratch();
  });

  beforeEach(() => {
    resetCounters();
  });

  it("throws CardNumberRefusedError and writes nothing at all", async () => {
    const before = await counts();
    await expect(
      postGuestMessage(deps(), client, { slug: SLUG, text: `mi tarjeta es ${CARD}` }),
    ).rejects.toBeInstanceOf(CardNumberRefusedError);
    expect(await counts()).toEqual(before);
    expect(counterTotal("pii_blocked_total")).toBe(1);
  });

  it("refuses before resolving the property — a bogus slug still refuses, not 404s", async () => {
    await expect(
      postGuestMessage(deps(), client, { slug: "no-such-hotel", text: `card ${CARD}` }),
    ).rejects.toBeInstanceOf(CardNumberRefusedError);
    expect(counterTotal("pii_blocked_total")).toBe(1);
  });

  it("counts each refused turn, and only refused ones", async () => {
    await expect(
      postGuestMessage(deps(), client, { slug: SLUG, text: "4111 1111 1111 1111" }),
    ).rejects.toBeInstanceOf(CardNumberRefusedError);
    // A 12-digit non-Luhn run is a room number or a phone, not a card. The turn is
    // ALLOWED to succeed — that is the false-positive half of the guarantee, and
    // asserting `.rejects` here would have been wrong (it resolves).
    const allowed = await postGuestMessage(deps(), client, {
      slug: SLUG,
      text: "habitación 1234 5678 9012",
    }).catch((error: unknown) => error);
    expect(allowed).not.toBeInstanceOf(CardNumberRefusedError);
    expect(counterTotal("pii_blocked_total")).toBe(1);
  });

  it("maps to 422 with a stable code the guest screen keys its copy off", () => {
    expect(classifyGuestError(new CardNumberRefusedError())).toEqual({
      status: 422,
      error: "card_number_not_allowed",
    });
  });

  it("never puts the refused text in a message or an event", async () => {
    const texts = await client.query<{ body: string }>("SELECT body FROM messages");
    const payloads = await client.query<{ payload: unknown }>("SELECT payload FROM events");
    const serialized = JSON.stringify([texts.rows, payloads.rows]);
    expect(serialized).not.toContain("4242");
    expect(serialized).not.toContain("4111");
    void orgId;
  });
});
