/**
 * S07-04 AC-1 — the bot check's port, with the vendor faked.
 *
 * The cases that matter are the ones where the check must NOT fail open: an
 * unreachable vendor, a malformed answer, a non-2xx. A bot check that passes when
 * the vendor is blocked is a control an attacker can disable by editing their own
 * hosts file.
 */
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/config/env.ts";
import {
  TURNSTILE_VERIFY_URL,
  loadBotCheckConfig,
  verifyBotCheck,
  type BotCheckConfig,
} from "../../src/security/botcheck.ts";

const ENFORCED: BotCheckConfig = { mode: "enforced", secret: "s3cret", timeoutMs: 1_000 };

function responder(status: number, body: unknown): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("loadBotCheckConfig", () => {
  it("is disabled in local when no secret is set", () => {
    expect(loadBotCheckConfig({}, "local")).toMatchObject({ mode: "disabled", secret: "" });
  });

  it("refuses to boot in staging or prod without a secret", () => {
    for (const env of ["staging", "prod"] as const) {
      expect(() => loadBotCheckConfig({}, env)).toThrow(ConfigError);
      expect(() => loadBotCheckConfig({}, env)).toThrow(/TURNSTILE_SECRET/);
    }
  });

  it("enforces whenever a secret is present, in every environment", () => {
    expect(loadBotCheckConfig({ TURNSTILE_SECRET: "abc" }, "local")).toMatchObject({
      mode: "enforced",
      secret: "abc",
    });
    expect(loadBotCheckConfig({ TURNSTILE_SECRET: "abc" }, "prod")).toMatchObject({
      mode: "enforced",
    });
  });

  it("rejects a nonsensical timeout", () => {
    expect(() =>
      loadBotCheckConfig({ TURNSTILE_SECRET: "abc", TURNSTILE_TIMEOUT_MS: "0" }, "prod"),
    ).toThrow(ConfigError);
  });
});

describe("verifyBotCheck", () => {
  it("passes without calling the vendor when the config is disabled", async () => {
    const fake = responder(200, { success: true });
    const result = await verifyBotCheck(
      { mode: "disabled", secret: "", timeoutMs: 1_000 },
      { token: "t", firstMessage: true },
      fake.fetch,
    );
    expect(result).toEqual({ ok: true, reason: "disabled" });
    expect(fake.calls).toHaveLength(0);
  });

  it("does not check anything after the first message (tokens are single use)", async () => {
    const fake = responder(200, { success: true });
    const result = await verifyBotCheck(ENFORCED, { token: null, firstMessage: false }, fake.fetch);
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a first message with no token, without calling the vendor", async () => {
    const fake = responder(200, { success: true });
    for (const token of [null, undefined, "", "   "]) {
      const result = await verifyBotCheck(ENFORCED, { token, firstMessage: true }, fake.fetch);
      expect(result).toEqual({ ok: false, reason: "missing_token" });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("posts the secret, the token and the address as a form, and accepts a pass", async () => {
    const fake = responder(200, { success: true });
    const result = await verifyBotCheck(
      ENFORCED,
      { token: "tok", firstMessage: true, remoteIp: "198.51.100.1" },
      fake.fetch,
    );
    expect(result).toEqual({ ok: true, reason: "verified" });
    expect(fake.calls[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    const init = fake.calls[0]!.init!;
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("secret")).toBe("s3cret");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("198.51.100.1");
  });

  it("reports the vendor's error codes and never the token", async () => {
    const fake = responder(200, { success: false, "error-codes": ["invalid-input-response"] });
    const result = await verifyBotCheck(ENFORCED, { token: "tok", firstMessage: true }, fake.fetch);
    expect(result).toMatchObject({ ok: false, reason: "vendor_rejected" });
    expect(result.detail).toBe("invalid-input-response");
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it("fails closed when the vendor is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await verifyBotCheck(ENFORCED, { token: "tok", firstMessage: true }, fetchImpl);
    expect(result).toEqual({ ok: false, reason: "vendor_unreachable" });
  });

  it("fails closed on a non-2xx and on a non-JSON body", async () => {
    const serverError = await verifyBotCheck(
      ENFORCED,
      { token: "tok", firstMessage: true },
      responder(503, { success: true }).fetch,
    );
    expect(serverError.ok).toBe(false);
    expect(serverError.reason).toBe("vendor_unreachable");

    const html = await verifyBotCheck(
      ENFORCED,
      { token: "tok", firstMessage: true },
      responder(200, "<html>maintenance</html>").fetch,
    );
    expect(html).toMatchObject({ ok: false, reason: "vendor_unreachable" });
  });

  it("does not treat a missing `success` field as a pass", async () => {
    const result = await verifyBotCheck(
      ENFORCED,
      { token: "tok", firstMessage: true },
      responder(200, {}).fetch,
    );
    expect(result.ok).toBe(false);
  });

  it("logs a rejection without the token", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Parameters<typeof verifyBotCheck>[3];
    await verifyBotCheck(
      ENFORCED,
      { token: "super-secret-token", firstMessage: true },
      responder(200, { success: false, "error-codes": ["timeout-or-duplicate"] }).fetch,
      logger,
    );
    const logged = JSON.stringify((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn.mock.calls);
    expect(logged).toContain("timeout-or-duplicate");
    expect(logged).not.toContain("super-secret-token");
  });
});
