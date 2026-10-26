/** Request transitions run on the caller's withStaffSession transaction. */
import type pg from "pg";
import type { StaffSession, TenantContext } from "../auth/context.ts";
import { assertTenantShape } from "../db/tenant.ts";
import { writeAudit } from "../audit/write.ts";
import { emitEvent } from "../events/emit.ts";

export const REQUEST_STATUSES = ["new", "acknowledged", "assigned", "resolved", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const NEXT: Record<RequestStatus, readonly RequestStatus[]> = {
  new: ["acknowledged"],
  acknowledged: ["assigned"],
  assigned: ["resolved", "cancelled"],
  resolved: [],
  cancelled: [],
};

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return from === to || NEXT[from].includes(to);
}

export class RequestLifecycleError extends Error {}
export class RequestNotFoundError extends Error {}

export async function transitionRequest(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  requestId: string,
  to: RequestStatus,
  assigneeUserId?: string,
): Promise<{ status: RequestStatus; changed: boolean }> {
  session.requireRole("queue", "write");
  assertTenantShape(context);
  if (!REQUEST_STATUSES.includes(to)) throw new RequestLifecycleError("invalid status");
  const result = await client.query<{
    status: RequestStatus; conversation_id: string | null;
  }>(
    `SELECT status, conversation_id FROM service_requests
     WHERE org_id = $1 AND property_id = $2 AND request_id = $3 FOR UPDATE`,
    [context.orgId, context.propertyId, requestId],
  );
  const row = result.rows[0];
  if (!row) throw new RequestNotFoundError("request not found");
  if (!canTransitionRequest(row.status, to)) {
    throw new RequestLifecycleError(`illegal request transition ${row.status} → ${to}`);
  }
  if (row.status === to) return { status: to, changed: false };
  if (to === "new") throw new RequestLifecycleError("cannot reopen request");
  // Canonical request events require a conversation; never silently omit one.
  if (!row.conversation_id) throw new RequestLifecycleError("request has no conversation");
  if (to === "assigned") {
    const assignee = assigneeUserId ?? session.userUuid;
    const member = await client.query(
      "SELECT 1 FROM memberships WHERE property_id = $1 AND user_id = $2",
      [context.propertyId, assignee],
    );
    if (!member.rowCount) throw new RequestLifecycleError("assignee is not a property member");
    await client.query(
      `INSERT INTO assignments (org_id, property_id, request_id, assigned_to)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, property_id, request_id, assigned_to) DO NOTHING`,
      [context.orgId, context.propertyId, requestId, assignee],
    );
  }
  await client.query(
    `UPDATE service_requests SET status = $4,
       acknowledged_at = CASE WHEN $4 = 'acknowledged' THEN now() ELSE acknowledged_at END,
       acknowledged_by = CASE WHEN $4 = 'acknowledged' THEN $5::uuid ELSE acknowledged_by END,
       resolved_at = CASE WHEN $4 = 'resolved' THEN now() ELSE resolved_at END
     WHERE org_id = $1 AND property_id = $2 AND request_id = $3`,
    [context.orgId, context.propertyId, requestId, to, session.userUuid],
  );
  await writeAudit(client, {
    ...context, actorUserId: session.userUuid,
    action: `request.${to}`, entityType: "request", entityId: requestId,
    detail: { previous: row.status, status: to },
  });
  if (to !== "cancelled") {
    // Only legal non-identity transitions reach here: 'new' is not a target.
    await emitEvent(client, context, `request_${to}`, {
      ...context, conversationId: row.conversation_id, channel: "web",
      language: null, topic: null, createdAt: new Date().toISOString(),
    }, { request_id: requestId, actor_user_id: session.userUuid,
      ...(to === "assigned" ? { assigned_to: assigneeUserId ?? session.userUuid } : {}) });
  }
  return { status: to, changed: true };
}
