import type pg from "pg";
import { isAuditAction, isEntityType, type AuditAction, type EntityType } from "./actions.ts";
import { assertSafeDetail } from "./detail.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditEntry {
  orgId: string;
  propertyId: string;
  actorUserId: string | null;
  action: AuditAction;
  entityType: EntityType;
  entityId: string;
  detail?: Record<string, unknown>;
}

export class AuditWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditWriteError";
  }
}

function assertUuid(name: string, value: string): void {
  if (!UUID.test(value)) throw new AuditWriteError(`${name} must be a UUID`);
}

export async function writeAudit(client: pg.Client, entry: AuditEntry): Promise<bigint> {
  if (!isAuditAction(entry.action)) {
    throw new AuditWriteError(`unknown audit action "${String(entry.action)}"`);
  }
  if (!isEntityType(entry.entityType)) {
    throw new AuditWriteError(`unknown audit entity type "${String(entry.entityType)}"`);
  }

  assertUuid("orgId", entry.orgId);
  assertUuid("propertyId", entry.propertyId);
  if (entry.actorUserId !== null) assertUuid("actorUserId", entry.actorUserId);
  if (entry.entityId.trim().length === 0) {
    throw new AuditWriteError("entityId must be a non-empty string");
  }

  const detail = entry.detail ?? {};
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    throw new AuditWriteError("detail must be a plain object");
  }
  assertSafeDetail(detail);

  const result = await client.query<{ audit_id: string }>(
    `INSERT INTO audit_log
       (org_id, property_id, actor_user_id, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING audit_id`,
    [
      entry.orgId,
      entry.propertyId,
      entry.actorUserId,
      entry.action,
      entry.entityType,
      entry.entityId,
      JSON.stringify(detail),
    ],
  );

  if (result.rowCount !== 1) throw new AuditWriteError("audit insert did not return a row");
  return BigInt(result.rows[0]!.audit_id);
}
