import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { assertProjectWrite, projectReadScope, ForbiddenError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { recalculateRag } from "@/server/rag-service";
import { withUserDb } from "@/server/db";
import {
  syncBatchSchema,
  type SyncOperation,
  type SyncOpResult,
} from "@/lib/validators";
import type { SessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Offline delta-sync endpoint.
 *
 * Clients queue mutations in IndexedDB while offline and POST them here in
 * order on reconnect. Guarantees:
 *  - Idempotency: each op carries a client-generated UUID; replays are skipped.
 *  - Tenant isolation: RLS transaction context + the same RBAC guards as
 *    online writes, per operation.
 *  - Conflict policy: EXPLICIT resolution. A version clash is never silently
 *    overwritten (no last-write-wins) — the server returns its authoritative
 *    state and the user resolves Keep Mine / Keep Theirs in the Sync Tray.
 */

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function applyOperation(user: SessionUser, op: SyncOperation): Promise<SyncOpResult> {
  // SyncMutationLog is deliberately outside RLS: it is keyed by clientOpId
  // and never queried cross-tenant.
  const duplicate = await prisma.syncMutationLog.findUnique({
    where: { clientOpId: op.clientOpId },
  });
  if (duplicate) {
    return { clientOpId: op.clientOpId, status: "duplicate" };
  }

  try {
    switch (op.kind) {
      case "project.update": {
        const { projectId, expectedSyncVersion, patch } = op.data;
        return await withUserDb(user, async (tx): Promise<SyncOpResult> => {
          const project = await tx.project.findFirst({
            where: { id: projectId, ...projectReadScope(user) },
          });
          if (!project) {
            return { clientOpId: op.clientOpId, status: "rejected", message: "Project not found" };
          }
          assertProjectWrite(user, project);

          if (project.syncVersion !== expectedSyncVersion) {
            // Explicit conflict: record it and hand back authoritative state.
            await tx.syncMutationLog.create({
              data: {
                clientOpId: op.clientOpId,
                userId: user.id,
                entityType: "Project",
                entityId: projectId,
                operation: "update",
                payload: asJson(op.data),
                conflict: true,
                conflictNote: `client expected v${expectedSyncVersion}, server at v${project.syncVersion} — awaiting explicit resolution`,
              },
            });
            return {
              clientOpId: op.clientOpId,
              status: "conflict",
              message:
                "This project changed on the server while you were offline. Review and choose Keep Mine or Keep Theirs.",
              serverState: {
                projectId: project.id,
                syncVersion: project.syncVersion,
                title: project.title,
                description: project.description,
                status: project.status,
                currentGate: project.currentGate,
                startDate: project.startDate,
                targetEndDate: project.targetEndDate,
              },
            };
          }

          await tx.project.update({
            where: { id: project.id },
            data: { ...patch, syncVersion: { increment: 1 } },
          });
          await tx.syncMutationLog.create({
            data: {
              clientOpId: op.clientOpId,
              userId: user.id,
              entityType: "Project",
              entityId: project.id,
              operation: "update",
              payload: asJson(op.data),
            },
          });
          await writeAudit(
            {
              userId: user.id,
              action: "SYNC",
              entityType: "Project",
              entityId: project.id,
              previous: { status: project.status, currentGate: project.currentGate },
              next: patch,
            },
            tx
          );
          return { clientOpId: op.clientOpId, status: "applied" };
        });
      }

      case "blocker.create": {
        const { projectId, title, description, severity, targetResolutionDate } = op.data;

        // Preserve the offline timestamp so SLA clocks start when the blocker
        // was actually raised — clamped to [now - 7d, now] so a skewed or
        // malicious client clock cannot trigger instant CIO escalation.
        const now = Date.now();
        const MAX_BACKDATE_MS = 7 * 86_400_000;
        const clampedCreatedAt = new Date(
          Math.min(now, Math.max(now - MAX_BACKDATE_MS, op.occurredAt.getTime()))
        );

        const result = await withUserDb(user, async (tx): Promise<SyncOpResult> => {
          const project = await tx.project.findFirst({
            where: { id: projectId, ...projectReadScope(user) },
          });
          if (!project) {
            return { clientOpId: op.clientOpId, status: "rejected", message: "Project not found" };
          }
          assertProjectWrite(user, project);

          const blocker = await tx.blocker.create({
            data: {
              projectId,
              raisedById: user.id,
              title,
              description,
              severity,
              targetResolutionDate: targetResolutionDate ?? null,
              createdAt: clampedCreatedAt,
            },
          });
          await tx.syncMutationLog.create({
            data: {
              clientOpId: op.clientOpId,
              userId: user.id,
              entityType: "Blocker",
              entityId: blocker.id,
              operation: "create",
              payload: asJson(op.data),
            },
          });
          await writeAudit(
            {
              userId: user.id,
              action: "SYNC",
              entityType: "Blocker",
              entityId: blocker.id,
              next: { projectId, title, severity },
            },
            tx
          );
          return { clientOpId: op.clientOpId, status: "applied" };
        });

        if (result.status === "applied") await recalculateRag([projectId]);
        return result;
      }

      case "blocker.resolve": {
        const { blockerId, resolutionNotes } = op.data;
        const result = await withUserDb(user, async (tx): Promise<SyncOpResult & { projectId?: string }> => {
          const blocker = await tx.blocker.findFirst({
            where: { id: blockerId, project: projectReadScope(user) },
            include: { project: true },
          });
          if (!blocker) {
            return { clientOpId: op.clientOpId, status: "rejected", message: "Blocker not found" };
          }
          assertProjectWrite(user, blocker.project);
          if (blocker.status === "RESOLVED") {
            return { clientOpId: op.clientOpId, status: "duplicate", message: "Already resolved" };
          }

          await tx.blocker.update({
            where: { id: blocker.id },
            data: { status: "RESOLVED", resolvedAt: new Date(), resolutionNotes },
          });
          await tx.syncMutationLog.create({
            data: {
              clientOpId: op.clientOpId,
              userId: user.id,
              entityType: "Blocker",
              entityId: blocker.id,
              operation: "update",
              payload: asJson(op.data),
            },
          });
          await writeAudit(
            {
              userId: user.id,
              action: "SYNC",
              entityType: "Blocker",
              entityId: blocker.id,
              previous: { status: blocker.status },
              next: { status: "RESOLVED", resolutionNotes },
            },
            tx
          );
          return { clientOpId: op.clientOpId, status: "applied", projectId: blocker.projectId };
        });

        if (result.status === "applied" && result.projectId) {
          await recalculateRag([result.projectId]);
        }
        return { clientOpId: result.clientOpId, status: result.status, message: result.message };
      }
    }
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { clientOpId: op.clientOpId, status: "rejected", message: err.message };
    }
    console.error("[sync] operation failed", op.kind, err);
    return {
      clientOpId: op.clientOpId,
      status: "rejected",
      message: "Internal error applying operation",
    };
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = syncBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid sync batch", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  // Apply strictly in client order — later ops may depend on earlier ones.
  const results: SyncOpResult[] = [];
  for (const op of parsed.data.operations) {
    results.push(await applyOperation(user, op));
  }

  return NextResponse.json({ results });
}
