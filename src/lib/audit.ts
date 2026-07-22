import "server-only";

import type { AuditAction, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/request-ip";

/**
 * COBIT 2019 audit trail (Gate 6).
 *
 * Every state-changing operation writes an immutable AuditLog row inside the
 * SAME transaction as the mutation — a change without its audit record cannot
 * be committed. Rows are insert-only; no update/delete path exists in the app.
 */

export interface AuditEntry {
  userId: string | null; // null = system actor (SLA sweep, migrations)
  action: AuditAction;
  entityType: string;
  entityId: string;
  previous?: unknown;
  next?: unknown;
  ipAddress?: string | null;
}

type Tx = Prisma.TransactionClient;

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  // Serialize through JSON to strip Date/Decimal instances into plain values.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Write an audit record. Pass the active transaction client to make it atomic.
 * Client IP is captured automatically from the request headers when not
 * supplied (SRS Module 1: timestamp, user, IP, previous state, new state).
 */
export async function writeAudit(entry: AuditEntry, tx: Tx = prisma): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      previous: toJson(entry.previous),
      next: toJson(entry.next),
      ipAddress: entry.ipAddress ?? getClientIp(),
    },
  });
}

/** Read the audit history of one entity, newest first. */
export async function auditHistory(entityType: string, entityId: string, limit = 50) {
  return prisma.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { name: true, email: true, role: true } } },
  });
}
