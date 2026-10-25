import type pg from "pg";

export interface AuditContext {
  orgId: string;
  propertyId: string;
}

export interface AuditRow {
  auditId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export interface ListAuditOptions {
  limit?: number;
  beforeId?: string;
}

export class AuditReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditReadError";
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listAudit(
  client: pg.Client,
  context: AuditContext,
  options: ListAuditOptions = {},
): Promise<AuditRow[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AuditReadError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }

  const values: unknown[] = [context.orgId, context.propertyId, limit];
  let cursor = "";
  if (options.beforeId !== undefined) {
    if (!/^[0-9]+$/.test(options.beforeId)) {
      throw new AuditReadError("beforeId must be a positive integer string");
    }
    values.push(options.beforeId);
    cursor = "AND audit_id < $4::bigint";
  }

  const result = await client.query<{
    audit_id: string;
    actor_user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    detail: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT audit_id::text AS audit_id,
            actor_user_id,
            action,
            entity_type,
            entity_id,
            detail,
            created_at
       FROM audit_log
      WHERE org_id = $1
        AND property_id = $2
        ${cursor}
      ORDER BY audit_id DESC
      LIMIT $3`,
    values,
  );

  return result.rows.map((row) => ({
    auditId: row.audit_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}
