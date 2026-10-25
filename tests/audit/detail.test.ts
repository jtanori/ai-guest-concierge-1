import { describe, expect, it } from "vitest";
import { assertSafeDetail, UnsafeAuditDetailError } from "../../src/audit/detail.ts";

function expectUnsafe(detail: Record<string, unknown>): void {
  expect(() => assertSafeDetail(detail)).toThrow(UnsafeAuditDetailError);
}

describe("audit detail guard (S02-03)", () => {
  it("accepts the settings.changed shape and ordinary business keys", () => {
    expect(() => assertSafeDetail({ changed: ["tone", "retention_days"] })).not.toThrow();
    expect(() =>
      assertSafeDetail({ company: "Hotel Paraiso", count: 2, nested: { ok: true } }),
    ).not.toThrow();
  });

  it("rejects unsafe keys at the top level", () => {
    for (const key of [
      "body",
      "message_body",
      "content",
      "card_number",
      "pan",
      "token",
      "secret",
      "password",
    ]) {
      expectUnsafe({ [key]: "value" });
    }
  });

  it("rejects unsafe keys nested one level down and in camelCase", () => {
    expectUnsafe({ meta: { guestBody: "hello" } });
    expectUnsafe({ meta: { access_token: "abc" } });
    expectUnsafe({ list: [{ apiSecret: "abc" }] });
  });

  it("rejects values that JSON cannot retain", () => {
    expectUnsafe({ value: undefined });
    expectUnsafe({ value: () => undefined });
    expectUnsafe({ value: 1n });
    expectUnsafe({ value: Number.NaN });
    expectUnsafe({ value: Number.POSITIVE_INFINITY });
    expectUnsafe({ value: new Date() });
  });

  it("rejects circular references", () => {
    const value: Record<string, unknown> = {};
    value["self"] = value;
    expectUnsafe(value);
  });
});
