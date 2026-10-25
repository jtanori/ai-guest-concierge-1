import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { emitEvent } from "../../src/events/emit.ts";
import {
  EVENT_NAMES,
  EventError,
  type EventContext,
  type EventName,
} from "../../src/events/taxonomy.ts";
import { LANGUAGES } from "../../src/i18n/catalog.ts";

const tenant = {
  orgId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  propertyId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
};
const context: EventContext = {
  ...tenant,
  conversationId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  channel: "web",
  language: "es",
  topic: "pool.hours",
  createdAt: "2026-10-25T12:00:00.000Z",
};
function fakeClient() {
  const query = vi.fn().mockResolvedValue({
    rowCount: 1,
    rows: [{ event_id: "9007199254740993" }],
  });
  return { query, client: { query } as unknown as pg.Client };
}

describe("emitEvent", () => {
  it("maps the event to one parameterized INSERT and returns a lossless bigint id", async () => {
    const { query, client } = fakeClient();
    const payload = { reason: "test' ); DROP TABLE events; --", count: 2 };
    const ctx = { ...context, topic: "a' ); --" };
    expect(await emitEvent(client, tenant, "ai_escalated", ctx, payload)).toBe(
      9007199254740993n,
    );
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toMatch(
      /INSERT INTO events\s+\(org_id, property_id, conversation_id, channel, language, topic,\s+event_type, payload, created_at\)/,
    );
    expect(sql).toContain(
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)",
    );
    expect(sql).toContain("RETURNING event_id");
    expect(sql).not.toContain(ctx.topic);
    expect(sql).not.toContain(payload.reason);
    expect(values).toEqual([
      tenant.orgId,
      tenant.propertyId,
      context.conversationId,
      "web",
      "es",
      ctx.topic,
      "ai_escalated",
      JSON.stringify(payload),
      context.createdAt,
    ]);
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|set_config)\b/i);
  });

  it.each(EVENT_NAMES)("accepts canonical event %s", async (name) => {
    const { client, query } = fakeClient();
    await emitEvent(client, tenant, name, context);
    expect(query.mock.calls[0]![1][6]).toBe(name);
  });

  it("preserves null language/topic and supports WhatsApp and EN", async () => {
    const { client, query } = fakeClient();
    await emitEvent(
      client,
      tenant,
      "message_received",
      { ...context, channel: "whatsapp", language: null, topic: null },
      null,
    );
    expect(query.mock.calls[0]![1].slice(3, 6)).toEqual([
      "whatsapp",
      null,
      null,
    ]);
    expect(query.mock.calls[0]![1][7]).toBe("{}");
    await emitEvent(client, tenant, "message_received", {
      ...context,
      language: "en",
    });
    expect(query.mock.calls[1]![1][4]).toBe("en");
  });

  it("uses an empty object for omitted payload", async () => {
    const { client, query } = fakeClient();
    await emitEvent(client, tenant, "conversation_started", context);
    expect(query.mock.calls[0]![1][7]).toBe("{}");
  });

  it("compares UUID tenant identity case-insensitively", async () => {
    const { client } = fakeClient();
    await expect(
      emitEvent(client, tenant, "message_received", {
        ...context,
        orgId: tenant.orgId.toUpperCase(),
        propertyId: tenant.propertyId.toUpperCase(),
      }),
    ).resolves.toBe(9007199254740993n);
  });

  it.each(["other", "", undefined, null, 42])(
    "rejects runtime event name %s before SQL",
    async (type) => {
      const { client, query } = fakeClient();
      await expect(
        emitEvent(client, tenant, type as EventName, context),
      ).rejects.toBeInstanceOf(EventError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([{ orgId: "" }, { propertyId: "not-uuid" }])(
    "rejects invalid tenant shape %j before SQL",
    async (patch) => {
      const { client, query } = fakeClient();
      await expect(
        emitEvent(
          client,
          { ...tenant, ...patch } as typeof tenant,
          "message_received",
          context,
        ),
      ).rejects.toBeInstanceOf(EventError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    { orgId: "dddddddd-dddd-dddd-dddd-dddddddddddd" },
    { propertyId: "dddddddd-dddd-dddd-dddd-dddddddddddd" },
  ])("rejects tenant mismatch %j before SQL", async (patch) => {
    const { client, query } = fakeClient();
    await expect(
      emitEvent(client, tenant, "message_received", { ...context, ...patch }),
    ).rejects.toThrow("event tenant does not match");
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { orgId: "" },
    { propertyId: "" },
    { conversationId: "" },
    { orgId: 3 },
    { propertyId: null },
    { conversationId: undefined },
    { conversationId: "not-uuid" },
    { channel: "sms" },
    { createdAt: "" },
    { createdAt: "not-a-date" },
    { createdAt: 123 },
    { language: undefined },
    { language: "fr" },
    { topic: "" },
    { topic: "   " },
    { topic: "\t\n" },
    { topic: undefined },
    { topic: 42 },
  ])("rejects invalid runtime context %j before SQL", async (patch) => {
    const { client, query } = fakeClient();
    await expect(
      emitEvent(client, tenant, "message_received", {
        ...context,
        ...patch,
      } as EventContext),
    ).rejects.toBeInstanceOf(EventError);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([null, undefined])(
    "rejects missing event context %s before SQL",
    async (ctx) => {
      const { client, query } = fakeClient();
      await expect(
        emitEvent(
          client,
          tenant,
          "message_received",
          ctx as unknown as EventContext,
        ),
      ).rejects.toBeInstanceOf(EventError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    [],
    "text",
    12,
    true,
    { toJSON: () => null },
    { toJSON: () => [] },
    { toJSON: () => undefined },
  ])(
    "rejects non-object or non-object-serializing payload %j before SQL",
    async (data) => {
      const { client, query } = fakeClient();
      await expect(
        emitEvent(
          client,
          tenant,
          "message_received",
          context,
          data as unknown as Record<string, unknown>,
        ),
      ).rejects.toBeInstanceOf(EventError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("propagates serialization failures before SQL", async () => {
    const { client, query } = fakeClient();
    const data: Record<string, unknown> = {};
    data.self = data;
    await expect(
      emitEvent(client, tenant, "message_received", context, data),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      emitEvent(client, tenant, "message_received", context, { number: 1n }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates the identical database error without rollback, retry or logging", async () => {
    const { client, query } = fakeClient();
    const failure = new Error("database rejected insert");
    query.mockRejectedValueOnce(failure);
    await expect(
      emitEvent(client, tenant, "message_received", context),
    ).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 2, rows: [{ event_id: "1" }] },
  ])("rejects an unsuccessful insert result %j", async (result) => {
    const { client, query } = fakeClient();
    query.mockResolvedValueOnce(result);
    await expect(
      emitEvent(client, tenant, "message_received", context),
    ).rejects.toBeInstanceOf(EventError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(LANGUAGES)("accepts catalog language %s", async (language) => {
    const { client, query } = fakeClient();
    await emitEvent(client, tenant, "message_received", {
      ...context,
      language,
    });
    expect(query.mock.calls[0]![1][4]).toBe(language);
  });

  it.each([null, undefined])(
    "rejects missing tenant context %s as EventError before SQL",
    async (ctx) => {
      const { client, query } = fakeClient();
      await expect(
        emitEvent(
          client,
          ctx as unknown as typeof tenant,
          "message_received",
          context,
        ),
      ).rejects.toBeInstanceOf(EventError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("preserves nonblank topic text without silently trimming it", async () => {
    const { client, query } = fakeClient();
    await emitEvent(client, tenant, "message_received", {
      ...context,
      topic: " pool.hours ",
    });
    expect(query.mock.calls[0]![1][5]).toBe(" pool.hours ");
  });
});
