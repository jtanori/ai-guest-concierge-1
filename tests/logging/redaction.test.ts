/**
 * S11-03 / AC-1 — "never logged", tested where logs are actually written.
 *
 * Every case goes through `createLogger` and a real pino destination, not through
 * `maskPii` alone: the hook could be installed wrong, or a future `createLogger`
 * could lose it, and a unit test of the mask would still pass. The assertion is on
 * the serialized line, because that is what leaves the process.
 *
 * The synthetic card is the canonical `4242 4242 4242 4242` — Luhn-valid, famously a
 * test number, and deliberately present in the suite (see AC-3 evidence in the
 * runbook: a fixture may contain a *synthetic* card, never a real one).
 */
import { describe, expect, it } from "vitest";
import type { DestinationStream } from "pino";
import { createLogger, reportError, type RequestContext } from "../../src/logging/index.ts";
import { redactValue } from "../../src/logging/redact.ts";
import { containsCardLike, containsPii, maskPii, passesLuhn } from "../../src/security/pii.ts";

const CARD = "4242 4242 4242 4242";
const CARD_DIGITS = "4242424242424242";
const EMAIL = "guest.name@example.com";
const PHONE = "+52 638 123 4567";

const CTX: RequestContext = {
  orgId: "11111111-1111-5111-a111-111111111111",
  propertyId: "22222222-2222-5222-a222-222222222222",
  conversationId: "33333333-3333-5333-a333-333333333333",
};

/** A destination that keeps the serialized lines, so assertions are on the wire. */
function capture(): { lines: Record<string, unknown>[]; stream: DestinationStream } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    },
  };
}

describe("maskPii", () => {
  it("masks a Luhn-valid card and leaves a non-Luhn digit run alone", () => {
    expect(passesLuhn(CARD_DIGITS)).toBe(true);
    expect(maskPii(`card ${CARD}`)).toBe("card [card]");
    // A room number is not a card, and masking it would make logs useless.
    expect(maskPii("room 4242")).toBe("room 4242");
  });

  it("masks emails and phone numbers", () => {
    expect(maskPii(`write to ${EMAIL}`)).toBe("write to [email]");
    expect(maskPii(`call ${PHONE}`)).toBe("call [phone]");
  });

  it("does not touch a UUID, a timestamp or ordinary prose", () => {
    const uuid = "11111111-1111-5111-a111-111111111111";
    expect(maskPii(`conversation ${uuid}`)).toBe(`conversation ${uuid}`);
    expect(maskPii("the pool is open until 22:00")).toBe("the pool is open until 22:00");
    expect(containsPii("the pool is open until 22:00")).toBe(false);
  });

  it("detects a card the same way the outbound guardrail does", () => {
    expect(containsCardLike(CARD)).toBe(true);
    expect(containsCardLike("no card here")).toBe(false);
  });
});

describe("createLogger redaction", () => {
  it("masks every string field, at any depth, in the serialized line", () => {
    const { lines, stream } = capture();
    const log = createLogger("info", {}, stream);

    log.info(
      {
        body: `my card is ${CARD}`,
        question: `email ${EMAIL}`,
        answer: `call ${PHONE}`,
        payload: { detail: { note: CARD_DIGITS } },
        list: [CARD, EMAIL],
        metric: "conversations_started",
        count: 12,
      },
      `guest typed ${CARD}`,
    );

    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain(CARD_DIGITS);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain("638 123 4567");
    expect(serialized).toContain("[card]");
    expect(serialized).toContain("[email]");
    expect(serialized).toContain("[phone]");
    // Structural fields survive: redaction must not break the log's own schema.
    expect(lines[0]!["metric"]).toBe("conversations_started");
    expect(lines[0]!["count"]).toBe(12);
  });

  it("masks an Error passed to the logger", () => {
    const { lines, stream } = capture();
    const log = createLogger("error", {}, stream);
    log.error({ err: new Error(`insert failed for ${CARD}`) }, "write failed");
    expect(JSON.stringify(lines[0])).not.toContain(CARD_DIGITS);
    expect((lines[0]!["err"] as { message: string }).message).toContain("[card]");
  });

  it("masks the message-only form too", () => {
    const { lines, stream } = capture();
    const log = createLogger("warn", {}, stream);
    log.warn(`guest sent ${EMAIL}`);
    expect(JSON.stringify(lines[0])).not.toContain(EMAIL);
    expect(lines[0]!["msg"]).toContain("[email]");
  });

  it("masks what reportError hands to the reporter, not only what it logs", () => {
    const { lines, stream } = capture();
    const log = createLogger("error", {}, stream);
    const reported: Error[] = [];
    reportError(log, CTX, new Error(`boom for ${CARD}`), ({ error }) => reported.push(error));

    expect(JSON.stringify(lines[0])).not.toContain(CARD_DIGITS);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).not.toContain(CARD_DIGITS);
    // The tenant context is intact — masking must not cost the three fields W00-14
    // exists to guarantee.
    expect(lines[0]!["org_id"]).toBe(CTX.orgId);
    expect(lines[0]!["property_id"]).toBe(CTX.propertyId);
    expect(lines[0]!["conversation_id"]).toBe(CTX.conversationId);
  });
});

describe("redactValue", () => {
  it("leaves non-strings alone and stops at the depth limit", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(true)).toBe(true);
    let deep: Record<string, unknown> = { value: CARD };
    for (let index = 0; index < 12; index++) deep = { nested: deep };
    expect(JSON.stringify(redactValue(deep))).not.toContain(CARD_DIGITS);
  });

  it("does not mutate the caller's object", () => {
    const original = { body: CARD };
    redactValue(original);
    expect(original.body).toBe(CARD);
  });
});
