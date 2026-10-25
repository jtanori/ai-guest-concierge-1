import type pg from "pg";
import {
  assertTenantShape,
  TenantContextError,
  type TenantContext,
} from "../db/tenant.ts";
import { LANGUAGES } from "../i18n/catalog.ts";
import {
  createEvent,
  EventError,
  isEventName,
  type EventContext,
  type EventName,
} from "./taxonomy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Insert on the caller's transaction-scoped client (withTenant/withStaffSession).
 * Does not open/check/commit a transaction or acquire a connection. The caller
 * must not invoke this on an unscoped client; DB RLS remains the backstop.
 * Null/omitted data maps to {}, matching events.payload's NOT NULL default.
 * Returns bigint so the bigserial identifier cannot lose numeric precision.
 * Invalid tenant/event context and payload shape throw EventError. Blank
 * non-null topics are rejected; null is the sole unclassified topic value.
 * Serialization and DB errors propagate unchanged for caller-owned rollback.
 * Payload values use standard JSON.stringify semantics, not audit sanitization.
 */
export async function emitEvent(
  client: pg.Client | pg.PoolClient,
  tenantContext: TenantContext,
  type: EventName,
  eventContext: EventContext,
  data: Record<string, unknown> | null = null,
): Promise<bigint> {
  if (!tenantContext || typeof tenantContext !== "object") {
    throw new EventError("tenant context is required");
  }
  try {
    assertTenantShape(tenantContext);
  } catch (error) {
    if (error instanceof TenantContextError)
      throw new EventError(error.message);
    throw error;
  }
  if (!isEventName(type)) throw new EventError("unknown event name");
  if (!eventContext || typeof eventContext !== "object") {
    throw new EventError("event context is required");
  }
  // createEvent validates the canonical shape; additionally reject runtime
  // type violations its TypeScript-facing requiredField helper does not catch.
  const event = createEvent(type, eventContext, data);
  for (const id of [
    event.context.org_id,
    event.context.property_id,
    event.context.conversation_id,
  ]) {
    if (typeof id !== "string" || !UUID.test(id)) {
      throw new EventError("event identifiers must be UUIDs");
    }
  }
  if (
    event.context.org_id.toLowerCase() !== tenantContext.orgId.toLowerCase() ||
    event.context.property_id.toLowerCase() !==
      tenantContext.propertyId.toLowerCase()
  ) {
    throw new EventError("event tenant does not match transaction tenant");
  }
  if (
    typeof event.context.created_at !== "string" ||
    (event.context.language !== null &&
      !LANGUAGES.includes(event.context.language)) ||
    (event.context.topic !== null &&
      (typeof event.context.topic !== "string" ||
        event.context.topic.trim().length === 0))
  ) {
    throw new EventError("invalid event context fields");
  }
  if (data !== null && (typeof data !== "object" || Array.isArray(data))) {
    throw new EventError("event data must be an object or null");
  }
  const payload = JSON.stringify(event.data ?? {});
  // Custom toJSON hooks must not turn a payload into a scalar/array/null.
  if (payload === undefined)
    throw new EventError("event data must serialize to an object");
  const serialized: unknown = JSON.parse(payload);
  if (
    serialized === null ||
    typeof serialized !== "object" ||
    Array.isArray(serialized)
  ) {
    throw new EventError("event data must serialize to an object");
  }

  const result = await client.query<{ event_id: string }>(
    `INSERT INTO events
       (org_id, property_id, conversation_id, channel, language, topic,
        event_type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
     RETURNING event_id`,
    [
      event.context.org_id,
      event.context.property_id,
      event.context.conversation_id,
      event.context.channel,
      event.context.language,
      event.context.topic,
      event.type,
      payload,
      event.context.created_at,
    ],
  );
  if (result.rowCount !== 1 || !result.rows[0]) {
    throw new EventError("event insert did not return one row");
  }
  return BigInt(result.rows[0].event_id);
}
