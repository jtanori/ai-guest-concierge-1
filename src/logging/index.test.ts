import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  bindRequestContext,
  createLogger,
  reportError,
  type Logger,
  type RequestContext,
} from "./index.ts";

const CTX: RequestContext = {
  orgId: "org-1",
  propertyId: "prop-7",
  conversationId: "conv-99",
};

function captureLogger(): { logs: Array<Record<string, unknown>>; logger: Logger } {
  const logs: Array<Record<string, unknown>> = [];
  const sink = new Writable({
    write(chunk, _enc, callback) {
      logs.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      callback();
    },
  });
  return { logs, logger: createLogger("info", {}, sink) };
}

const discardLogger = (): Logger =>
  createLogger("info", {}, new Writable({ write(_c, _e, cb) { cb(); } }));

describe("W00-14 — structured logs carry tenant context", () => {
  it("a staging error carries org_id, property_id, conversation_id", () => {
    expect.assertions(5);
    const { logs, logger } = captureLogger();
    reportError(logger, CTX, new Error("db exploded"), () => {
      // local no-op reporter; Phase B wires Sentry here
    });

    expect(logs).toHaveLength(1);
    const entry = logs[0] as Record<string, unknown>;
    expect(entry["org_id"]).toBe("org-1");
    expect(entry["property_id"]).toBe("prop-7");
    expect(entry["conversation_id"]).toBe("conv-99");
    expect(entry["msg"]).toBe("staging error");
  });

  it("every child log line is stamped with the full request context", () => {
    const { logs, logger } = captureLogger();
    const log = bindRequestContext(logger, CTX);
    log.info({ event: "ai_answer_sent" }, "answer");

    expect(logs).toHaveLength(1);
    const entry = logs[0] as Record<string, unknown>;
    expect(entry["org_id"]).toBe("org-1");
    expect(entry["property_id"]).toBe("prop-7");
    expect(entry["conversation_id"]).toBe("conv-99");
  });

  it("conversation_id may be null (request without a conversation yet)", () => {
    const { logs, logger } = captureLogger();
    const log = bindRequestContext(logger, { ...CTX, conversationId: null });
    log.warn("no conversation attached");
    expect(logs[0]?.["conversation_id"]).toBeNull();
  });

  it("output is a single JSON object per line (structured, not free text)", () => {
    expect.assertions(2);
    const { logs, logger } = captureLogger();
    bindRequestContext(logger, CTX).info("request attached");
    const entry = logs[0] as Record<string, unknown>;
    expect(typeof entry["org_id"]).toBe("string");
    expect(entry["level"]).toBeGreaterThan(0);
  });

  it("the error reporter receives the same context it is given", () => {
    const received: string[] = [];
    reportError(discardLogger(), CTX, new Error("boom"), ({ ctx }) => {
      received.push(ctx.orgId, ctx.propertyId, ctx.conversationId ?? "");
    });
    expect(received).toEqual(["org-1", "prop-7", "conv-99"]);
  });
});
