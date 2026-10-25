import type pg from "pg";
import { writeAudit } from "./write.ts";
import type { AuditContext } from "./read.ts";

export interface SupportAccessInput {
  actorUserId: string;
  operatorEmail: string;
  reason: string;
  ticket?: string;
}

export class SupportAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportAccessError";
  }
}

export async function writeSupportAccess(
  client: pg.Client,
  context: AuditContext,
  input: SupportAccessInput,
): Promise<bigint> {
  const operatorEmail = input.operatorEmail.trim();
  const reason = input.reason.trim();
  if (operatorEmail.length === 0) throw new SupportAccessError("operatorEmail is required");
  if (reason.length === 0) throw new SupportAccessError("reason is required");

  const ticket = input.ticket?.trim();
  return writeAudit(client, {
    orgId: context.orgId,
    propertyId: context.propertyId,
    actorUserId: input.actorUserId,
    action: "support.access",
    entityType: "property",
    entityId: context.propertyId,
    detail: {
      operator_email: operatorEmail,
      reason,
      ...(ticket ? { ticket } : {}),
    },
  });
}
