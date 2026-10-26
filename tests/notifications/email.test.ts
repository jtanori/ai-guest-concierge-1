/**
 * S09-05 — the email notification, as far as it can be tested without a provider.
 *
 * DEC-4 closed on Resend but not on credentials, and §7's "a real delivered email"
 * is recorded as outstanding evidence rather than faked. So these tests cover
 * everything that is ours: who it goes to, what it says, and when it gives up. The
 * only untested code is the single HTTP call in src/providers/email.ts, which has
 * its own contract test against an injected fetch.
 *
 * The assertions worth reading are the negative ones. "The subject does not contain
 * what the guest wrote" is §7, and it is the kind of guarantee that silently rots
 * when someone decides the email would be more useful with a preview.
 */
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/env.ts";
import {
  composeRequestEmail,
  emailBackoffMs,
  loadEmailConfig,
  resolveRecipients,
  staffLanguage,
  EMAIL_MAX_ATTEMPTS,
} from "../../src/notifications/email.ts";
import {
  assertSenderAddress,
  emailIdempotencyKey,
  logOnlyProvider,
  resendProvider,
} from "../../src/providers/email.ts";
import type { EscalationContact } from "../../src/settings/schema.ts";

const FROM = "Concierge <desk@casamesa.example>";
const KEY = "re_test_key";
const FALLBACK = "oncall@operator.example";
const BASE = "https://console.example";

/** What the guest actually wrote. Distinctive on purpose: every test that asserts
 * this string is absent from somewhere is asserting §7. */
const GUEST_TEXT = "No hay agua caliente en la habitación 402, por favor";

function contact(name: string, channel: "in_app" | "email", value: string): EscalationContact {
  return { name, channel, value };
}

const LOCAL = { EMAIL_FROM: FROM };
const MSG = { to: ["desk@hotel.example"], subject: "s", text: "t", from: FROM };

/** A 200 with a JSON body, capturing the request. */
function fake200(captured: Record<string, unknown>): typeof fetch {
  return fakeJson(200, { id: "res_captured" }, captured);
}

function fakeJson(status: number, body: unknown, captured?: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    if (captured !== undefined) {
      captured.url = String(input);
      captured.init = init;
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}
const PROD = { EMAIL_FROM: FROM, EMAIL_API_KEY: KEY, EMAIL_ESCALATION_FALLBACK: FALLBACK, CONSOLE_BASE_URL: BASE };

describe("loadEmailConfig", () => {
  it("runs log-only in local with no API key", () => {
    const cfg = loadEmailConfig(LOCAL, "local");
    expect(cfg.provider).toBe("log");
    expect(cfg.apiKey).toBe("");
    expect(cfg.fallbackRecipient).toBeNull();
    expect(cfg.from).toBe(FROM);
  });

  it("refuses to boot in staging with no API key", () => {
    // The whole item is "the request reaches a human without the staff console".
    // A deployment that boots without a provider queues rows nobody sends, and the
    // failure surfaces as silence rather than as an error — so it fails at boot.
    expect(() => loadEmailConfig({ ...LOCAL, CONSOLE_BASE_URL: BASE }, "staging")).toThrow(ConfigError);
    expect(() => loadEmailConfig({ ...LOCAL, CONSOLE_BASE_URL: BASE }, "prod")).toThrow(ConfigError);
  });

  it("refuses to boot outside local with no fallback recipient", () => {
    // AC-2: a property with no contacts of its own must still reach somebody.
    // "Every property will have contacts configured" is not something a deployment
    // can promise on the day someone creates a property and forgets.
    expect(() =>
      loadEmailConfig({ EMAIL_FROM: FROM, EMAIL_API_KEY: KEY, CONSOLE_BASE_URL: BASE }, "prod"),
    ).toThrow(/EMAIL_ESCALATION_FALLBACK/);
    // Local may omit it: there is no real escalation to catch.
    expect(loadEmailConfig(LOCAL, "local").fallbackRecipient).toBeNull();
  });

  it("has no hardcoded fallback address", () => {
    // DEC-4: the operator names the address. A default in the repository would
    // collect every tenant's escalations forever, whether or not anyone reads it.
    const cfg = loadEmailConfig(PROD, "prod");
    expect(cfg.fallbackRecipient).toBe(FALLBACK);
    expect(loadEmailConfig(LOCAL, "local").fallbackRecipient).toBeNull();
  });

  it("requires a sender and rejects one that is not an address", () => {
    expect(() => loadEmailConfig({ EMAIL_FROM: "" }, "local")).toThrow(/EMAIL_FROM/);
    expect(() => loadEmailConfig({ EMAIL_FROM: "   " }, "local")).toThrow(/EMAIL_FROM/);
    expect(() => loadEmailConfig({ EMAIL_FROM: "not-an-address" }, "local")).toThrow(ConfigError);
    expect(assertSenderAddress("desk@example.com")).toBe("desk@example.com");
    expect(assertSenderAddress(FROM)).toBe(FROM);
  });

  it("rejects a fallback that is not an address", () => {
    expect(() =>
      loadEmailConfig({ ...PROD, EMAIL_ESCALATION_FALLBACK: "the-front-desk" }, "prod"),
    ).toThrow(/EMAIL_ESCALATION_FALLBACK/);
  });

  it("refuses to boot outside local with no console base URL", () => {
    // The default is http://localhost:3000, which RESOLVES — on the recipient's own
    // machine, to whatever they happen to be running there. That is worse than no
    // link: it looks like a working console link in a test send and fails for every
    // real recipient, at 3am, on the one email whose purpose is to be actionable.
    const withoutUrl = { EMAIL_FROM: FROM, EMAIL_API_KEY: KEY, EMAIL_ESCALATION_FALLBACK: FALLBACK };
    expect(() => loadEmailConfig(withoutUrl, "staging")).toThrow(/CONSOLE_BASE_URL/);
    expect(() => loadEmailConfig(withoutUrl, "prod")).toThrow(/CONSOLE_BASE_URL/);
    // Local keeps the default: the link then points at the dev server, which is the
    // machine the developer is sitting at.
    expect(loadEmailConfig(LOCAL, "local").consoleBaseUrl).toBe("http://localhost:3000");
    expect(loadEmailConfig(PROD, "prod").consoleBaseUrl).toBe(BASE);
  });

  it("strips a trailing slash from the console base and rejects a non-http one", () => {
    expect(loadEmailConfig({ ...PROD, CONSOLE_BASE_URL: "https://console.example///" }, "prod").consoleBaseUrl)
      .toBe("https://console.example");
    expect(() => loadEmailConfig({ ...PROD, CONSOLE_BASE_URL: "ftp://console.example" }, "prod")).toThrow(ConfigError);
    // Local may omit it entirely: the link then points at the dev server.
    expect(loadEmailConfig(LOCAL, "local").consoleBaseUrl).toBe("http://localhost:3000");
  });
});

describe("resolveRecipients", () => {
  it("uses the property's own email contacts", () => {
    const r = resolveRecipients(
      [contact("Recepción", "email", "desk@hotel.example"), contact("Gerente", "email", "gm@hotel.example")],
      FALLBACK,
    );
    expect(r.source).toBe("property");
    expect(r.to).toEqual(["desk@hotel.example", "gm@hotel.example"]);
  });

  it("ignores in_app contacts, which are not addresses", () => {
    // The inbox is a different delivery path. Emailing an in-app handle would mean
    // sending to a string that is not an address, and the provider would reject it
    // — five times, then dead.
    const r = resolveRecipients([contact("Recepción", "in_app", "reception-desk")], FALLBACK);
    expect(r.source).toBe("fallback");
    expect(r.to).toEqual([FALLBACK]);
  });

  it("skips a mistyped contact rather than failing the whole notification", () => {
    const r = resolveRecipients(
      [contact("Mal", "email", "nope"), contact("Bien", "email", "good@hotel.example")],
      FALLBACK,
    );
    expect(r.source).toBe("property");
    expect(r.to).toEqual(["good@hotel.example"]);
  });

  it("falls back only when the property has nobody", () => {
    expect(resolveRecipients([], FALLBACK)).toEqual({ to: [FALLBACK], source: "fallback" });
    expect(resolveRecipients([], null)).toEqual({ to: [], source: "none" });
  });

  it("deduplicates addresses case-insensitively", () => {
    const r = resolveRecipients(
      [contact("A", "email", "Desk@Hotel.example"), contact("B", "email", "desk@hotel.example")],
      FALLBACK,
    );
    expect(r.to).toHaveLength(1);
  });

  it("reports 'none' rather than an empty send", () => {
    // The case that must never be quiet. The worker turns this into a dead row plus
    // an audit entry; silently succeeding would record that a guest was handled.
    expect(resolveRecipients([], null).source).toBe("none");
  });
});

describe("staffLanguage", () => {
  it("reads the property's own primary language, not the guest's", () => {
    expect(staffLanguage(["en", "es"])).toBe("en");
    expect(staffLanguage(["es", "en"])).toBe("es");
  });

  it("falls back to Spanish for anything unrecognised", () => {
    expect(staffLanguage(["fr"])).toBe("es");
    expect(staffLanguage([])).toBe("es");
    expect(staffLanguage(null)).toBe("es");
  });
});

describe("composeRequestEmail", () => {
  const base = {
    propertyName: "Casa Mesa",
    requestId: "11111111-2222-3333-4444-555555555555",
    topic: "needs_human",
    conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    consoleBaseUrl: BASE,
  };
  const property = { to: ["desk@hotel.example"], source: "property" as const };
  const fallback = { to: [FALLBACK], source: "fallback" as const };

  it("keeps the guest's words out of the subject (§7)", () => {
    const email = composeRequestEmail({
      ...base,
      stage: "new",
      lang: "es",
      messageBody: GUEST_TEXT,
      recipients: property,
    });
    expect(email.subject).toContain("Casa Mesa");
    expect(email.subject).toContain(base.requestId);
    // The specific things a preview would leak: the room number and the complaint.
    expect(email.subject).not.toContain("402");
    expect(email.subject).not.toContain("agua caliente");
    expect(email.subject).not.toContain(GUEST_TEXT);
    // And it is not smuggled in as the property name or topic either.
    expect(email.subject.length).toBeLessThan(120);
  });

  it("quotes the guest in the body when it goes to the property's own contacts", () => {
    const email = composeRequestEmail({
      ...base,
      stage: "new",
      lang: "es",
      messageBody: GUEST_TEXT,
      recipients: property,
    });
    expect(email.redacted).toBe(false);
    expect(email.text).toContain(GUEST_TEXT);
    expect(email.text).toContain("Lo que escribió el huésped");
    expect(email.text).toContain(`${BASE}/inbox/${base.conversationId}`);
    expect(email.text).toContain("needs_human");
  });

  it("omits the guest's words when it goes to the deployment fallback", () => {
    // The fallback is operator level, not scoped to this property. Forwarding one
    // property's guest conversation to an address outside that property's access
    // boundary would be a disclosure; the pointer is still the whole notification.
    const email = composeRequestEmail({
      ...base,
      stage: "new",
      lang: "es",
      messageBody: GUEST_TEXT,
      recipients: fallback,
    });
    expect(email.redacted).toBe(true);
    expect(email.text).not.toContain(GUEST_TEXT);
    expect(email.text).not.toContain("402");
    expect(email.text).toContain("destinatario de respaldo");
    // Still actionable.
    expect(email.text).toContain(base.requestId);
    expect(email.text).toContain(`${BASE}/inbox/${base.conversationId}`);
  });

  it("prints no empty quote block for a button-tap request", () => {
    // "Talk to a person" opens a request with no message behind it. A body that
    // assumed text would send "What the guest wrote:" followed by nothing.
    const email = composeRequestEmail({
      ...base,
      stage: "new",
      lang: "es",
      messageBody: null,
      recipients: property,
    });
    expect(email.redacted).toBe(false);
    expect(email.text).not.toContain("Lo que escribió el huésped");
    expect(email.text).not.toContain("destinatario de respaldo");
    expect(email.text).toContain(base.requestId);
  });

  it("treats a whitespace-only message as no message", () => {
    const email = composeRequestEmail({
      ...base,
      stage: "new",
      lang: "es",
      messageBody: "   \n ",
      recipients: property,
    });
    expect(email.text).not.toContain("Lo que escribió el huésped");
  });

  it("names the acknowledging role, never the person", () => {
    // 0004's users.staff_select authorises your own row only, so a worker cannot
    // read a colleague's display_name — and should not quietly widen that.
    const email = composeRequestEmail({
      ...base,
      stage: "acknowledged",
      lang: "es",
      messageBody: null,
      recipients: property,
    });
    expect(email.subject).toContain("confirmada");
    expect(email.text).toContain("Un miembro de nuestro equipo");
    expect(email.text).not.toContain("Lo que escribió el huésped");
  });

  it("composes in English when the property says so", () => {
    const email = composeRequestEmail({
      ...base,
      stage: "new",
      lang: "en",
      messageBody: "No hot water in room 402",
      recipients: property,
    });
    expect(email.subject).toContain("New guest request at Casa Mesa");
    expect(email.text).toContain("What the guest wrote:");
    expect(email.text).toContain("Open it in the console:");
  });

  it("omits the console link when the conversation is gone", () => {
    // 0001 sets service_requests.conversation_id to NULL when the conversation is
    // deleted and the request row survives. The detail page is keyed by conversation
    // id, so there is no link to give — and `${base}/inbox/` would render as a real
    // URL that resolves to the inbox index or a 404, looking like a console bug
    // rather than a deleted conversation.
    const email = composeRequestEmail({
      ...base,
      stage: "new",
      lang: "es",
      conversationId: "",
      messageBody: GUEST_TEXT,
      recipients: property,
    });
    expect(email.text).not.toContain("/inbox/");
    expect(email.text).not.toContain("Ábrela en la consola");
    expect(email.text).toContain("ya no está disponible");
    // Still actionable: the request and the property are named, and the guest's
    // words are still quoted because these are the property's own contacts.
    expect(email.text).toContain(base.requestId);
    expect(email.text).toContain(GUEST_TEXT);
  });

  it("names the conversation when there is one", () => {
    const email = composeRequestEmail({
      ...base,
      stage: "new",
      lang: "en",
      messageBody: null,
      recipients: property,
    });
    expect(email.text).toContain(`Conversation: ${base.conversationId}`);
    expect(email.text).toContain(`${BASE}/inbox/${base.conversationId}`);
    expect(email.text).not.toContain("no longer available");
  });

  it("never emits an unfilled placeholder", () => {
    for (const lang of ["en", "es"] as const) {
      for (const stage of ["new", "acknowledged"] as const) {
        for (const recipients of [property, fallback]) {
          for (const messageBody of [GUEST_TEXT, null]) {
            for (const conversationId of [base.conversationId, ""]) {
              const email = composeRequestEmail({ ...base, stage, lang, messageBody, recipients, conversationId });
              expect(`${email.subject}${email.text}`).not.toMatch(/\{\w+\}/);
              // No link to nowhere, in any combination.
              if (conversationId === "") expect(email.text).not.toContain("/inbox/");
            }
          }
        }
      }
    }
  });
});

describe("emailBackoffMs", () => {
  it("doubles from a second and caps at a minute", () => {
    expect(emailBackoffMs(0)).toBe(1000);
    expect(emailBackoffMs(1)).toBe(2000);
    expect(emailBackoffMs(2)).toBe(4000);
    expect(emailBackoffMs(4)).toBe(16000);
    expect(emailBackoffMs(9)).toBe(60000);
    expect(emailBackoffMs(40)).toBe(60000);
  });

  it("has a ceiling on attempts", () => {
    // Bounded, so a permanently rejected address becomes a dead row an operator can
    // see rather than a row that retries forever.
    expect(EMAIL_MAX_ATTEMPTS).toBe(5);
  });
});

describe("resendProvider", () => {
  const message = { to: ["desk@hotel.example"], subject: "s", text: "t", from: FROM };

  /** Captures the request so the call shape is asserted, not assumed. Typed as
   * `typeof fetch` rather than `(url: string, ...)`: the adapter takes a fetch, and
   * a narrower fake would let the adapter's own signature drift unnoticed. */
  function fake(status: number, body: string, captured?: Record<string, unknown>): typeof fetch {
    return async (input, init) => {
      if (captured !== undefined) {
        captured.url = String(input);
        captured.init = init;
      }
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    };
  }

  it("posts a bearer-authenticated JSON body and returns the provider id", async () => {
    const captured: Record<string, unknown> = {};
    const provider = resendProvider({ apiKey: KEY, fetch: fake(200, '{"id":"res_1"}', captured) });
    const result = await provider.send(message);

    expect(result).toEqual({ ok: true, providerId: "res_1", retryable: false, reason: "sent" });
    expect(captured.url).toBe("https://api.resend.com/emails");
    const init = captured.init as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: FROM,
      to: ["desk@hotel.example"],
      subject: "s",
      text: "t",
    });
  });

  it("treats a 5xx as retryable and a 4xx as permanent", async () => {
    const p5 = resendProvider({ apiKey: KEY, fetch: fake(503, '{"message":"down"}') });
    expect((await p5.send(message)).retryable).toBe(true);
    expect((await p5.send(message)).reason).toBe("unavailable");

    const p4 = resendProvider({ apiKey: KEY, fetch: fake(403, '{"message":"invalid api key"}') });
    const rejected = await p4.send(message);
    expect(rejected.retryable).toBe(false);
    expect(rejected.reason).toBe("rejected");
    // Retrying a rejected key five times produces five identical refusals and a
    // dead row that looks exactly like an outage.
    expect(rejected.detail).toContain("invalid api key");
  });

  it("treats 429 as retryable even though it is a 4xx", () => {
    // Dropping notifications precisely when the property is busiest would be the
    // worst possible time to treat a rate limit as permanent.
    const provider = resendProvider({ apiKey: KEY, fetch: fake(429, '{"message":"slow down"}') });
    return expect(provider.send(message)).resolves.toMatchObject({ retryable: true, reason: "rate_limited" });
  });

  it("treats an unreachable provider as retryable and never leaks the key", async () => {
    const provider = resendProvider({
      apiKey: KEY,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const result = await provider.send(message);
    expect(result).toMatchObject({ ok: false, retryable: true, reason: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("reports a timeout distinctly", async () => {
    const provider = resendProvider({
      apiKey: KEY,
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    expect(await provider.send(message)).toMatchObject({ retryable: true, reason: "timeout" });
  });

  it("refuses to send to nobody", async () => {
    // Not a provider failure: there is no recipient, and the caller has already
    // recorded that. Sending anyway would be a 400 we caused.
    const provider = resendProvider({ apiKey: KEY, fetch: fake(200, '{"id":"x"}') });
    expect(await provider.send({ ...message, to: [] })).toMatchObject({
      ok: false,
      retryable: false,
      reason: "rejected",
    });
  });

  it("handles a non-JSON success body without inventing an id", async () => {
    const provider = resendProvider({ apiKey: KEY, fetch: fake(200, "not json") });
    expect(await provider.send(message)).toEqual({ ok: true, providerId: null, retryable: false, reason: "sent" });
  });
});

describe("idempotency keys", () => {
  it("is stable for a row and distinct between rows", () => {
    // Stable across retries of one row (so a lost response cannot become a second
    // email) and unique per row (so an operator re-queueing a dead row is a real
    // send rather than a suppressed one — Resend remembers keys for 24 hours).
    expect(emailIdempotencyKey(BigInt(42))).toBe(emailIdempotencyKey("42"));
    expect(emailIdempotencyKey(BigInt(42))).toBe("concierge-email/42");
    expect(emailIdempotencyKey(BigInt(43))).not.toBe(emailIdempotencyKey(BigInt(42)));
    // Resend caps keys at 256 characters.
    expect(emailIdempotencyKey(BigInt("9".repeat(30))).length).toBeLessThanOrEqual(256);
  });

  it("sends the key as a header when given one and omits it when not", async () => {
    const captured: Record<string, unknown> = {};
    const provider = resendProvider({ apiKey: KEY, fetch: fake200(captured) });
    const message = { to: ["desk@hotel.example"], subject: "s", text: "t", from: FROM };

    await provider.send({ ...message, idempotencyKey: "concierge-email/7" });
    const withKey = (captured.init as RequestInit).headers as Record<string, string>;
    expect(withKey["idempotency-key"]).toBe("concierge-email/7");

    await provider.send(message);
    const withoutKey = (captured.init as RequestInit).headers as Record<string, string>;
    expect(Object.keys(withoutKey)).not.toContain("idempotency-key");
  });

  it("treats an in-flight conflict as retryable", async () => {
    // Resend cannot replay the original answer while the first attempt is still
    // running; backing off is exactly what it asks for.
    const provider = resendProvider({
      apiKey: KEY,
      fetch: fakeJson(409, { name: "concurrent_idempotent_requests", message: "in progress" }),
    });
    expect(await provider.send(MSG)).toMatchObject({ retryable: true, reason: "conflict_in_flight" });
  });

  it("treats a payload conflict as permanent, not as a send", async () => {
    // Same key, different payload: an earlier attempt WAS accepted, and its content
    // is not what we would send now. Retrying 409s forever, and reporting `sent`
    // would claim a delivery whose content we cannot prove. So: dead, with its own
    // reason, for a human to look at.
    const provider = resendProvider({
      apiKey: KEY,
      fetch: fakeJson(409, { name: "invalid_idempotent_request", message: "key reused" }),
    });
    expect(await provider.send(MSG)).toMatchObject({
      ok: false,
      retryable: false,
      reason: "conflict_payload",
    });
  });

  it("distinguishes a 409 it does not recognise from the two idempotency codes", async () => {
    const provider = resendProvider({ apiKey: KEY, fetch: fakeJson(409, { message: "something else" }) });
    expect(await provider.send(MSG)).toMatchObject({ retryable: false, reason: "rejected" });
  });
});

describe("the timeout covers the response body", () => {
  it("does not hang when headers arrive and the body stalls", async () => {
    // `fetch` resolves as soon as the HEADERS arrive; the body is a separate stream.
    // Clearing the timer at that point leaves `response.text()` with no deadline, so
    // a provider that sends headers and then stalls the body hangs the worker
    // forever — while it holds a database transaction and a FOR UPDATE row lock, so
    // one stalled body pins an outbox row no other worker can claim.
    const provider = resendProvider({
      apiKey: KEY,
      timeoutMs: 25,
      fetch: (_url, init) => {
        const signal = init?.signal;
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) {
            // Never enqueue and never close: headers are delivered, the body is not.
            signal?.addEventListener("abort", () => {
              controller.error(new DOMException("This operation was aborted", "AbortError"));
            });
          },
        });
        return Promise.resolve(
          new Response(stalled, { status: 200, headers: { "content-type": "application/json" } }),
        );
      },
    });

    const started = Date.now();
    const result = await provider.send(MSG);
    // It returns, and it returns promptly rather than after some socket default.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result).toMatchObject({ ok: false, retryable: true, reason: "timeout" });
  });

  it("still clears its timer on a normal send", async () => {
    // A leaked timer per send would keep the worker's event loop alive and, over a
    // long queue, accumulate.
    const provider = resendProvider({ apiKey: KEY, timeoutMs: 5000, fetch: fakeJson(200, { id: "res_ok" }) });
    expect(await provider.send(MSG)).toMatchObject({ ok: true, providerId: "res_ok" });
  });
});

describe("logOnlyProvider", () => {
  it("records what it was asked to send and sends nothing", async () => {
    const provider = logOnlyProvider();
    const result = await provider.send({ to: ["a@b.c"], subject: "s", text: "t", from: FROM });
    expect(result.ok).toBe(true);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toEqual(["a@b.c"]);
  });

  it("can be made to fail, so retry behaviour is testable", async () => {
    const provider = logOnlyProvider();
    provider.failWith = { ok: false, providerId: null, retryable: true, reason: "unavailable", detail: "down" };
    expect((await provider.send({ to: ["a@b.c"], subject: "s", text: "t", from: FROM })).ok).toBe(false);
    expect(provider.sent).toHaveLength(0);
  });
});
