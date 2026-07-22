import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { assertProjectWrite, projectReadScope, ForbiddenError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { recalculateRag } from "@/server/actions/projects";
import {
  syncBatchSchema,
  type SyncOperation,
  type SyncOpResult,
} from "@/lib/validators";
import type { SessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Offline delta-sync endpoint (Gate 2).
 *
 * Clients queue mutations in IndexedDB while offline and POST them here in
 * order on reconnect. Guarantees:
 *  - Idempotency: each op carries a client-generated UUID; replays are skipped.
 *  - Tenant isolation: every op re-runs the same RBAC guards as online writes.
 *  - Conflict policy (SRS Module 4): syncVersion optimistic concurrency with
 *    Last-Write-Wins on server timestamps. If the offline edit occurred after
 *    the server's last change, it is applied (and flagged in SyncMutationLog);
 *    otherwise the server state stands and the client receives it to rebase.
 */

async function applyOperation(user: SessionUser, op: SyncOperation): Promise<SyncOpResult> {
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
        const project = await prisma.project.findFirst({
          where: { id: projectId, ...projectReadScope(user) },
        });
        if (!project) {
          return { clientOpId: op.clientOpId, status: "rejected", message: "Project not found" };
        }
        assertProjectWrite(user, project);

        if (project.syncVersion !== expectedSyncVersion) {
          // SRS Module 4: Last-Write-Wins with server timestamps. If the offline
          // edit happened AFTER the server's last change, the offline edit wins
          // (its clock is sanity-capped at "now" to block future-dated clients).
          const opTime = Math.min(op.occurredAt.getTime(), Date.now());
          if (opTime > project.updatedAt.getTime()) {
            await prisma.$transaction(async (tx) => {
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
                  payload: JSON.parse(JSON.stringify(op.data)) as Prisma.InputJsonValue,
                  conflict: true,
                  conflictNote: `LWW: offline edit (${op.occurredAt.toISOString()}) newer than server state (${project.updatedAt.toISOString()}) — applied`,
                },
              });
              await writeAudit(
                {
                  userId: user.id,
                  action: "SYNC",
                  entityType: "Project",
                  entityId: project.id,
                  previous: { status: project.status, currentGate: project.currentGate },
                  next: { ...patch, _conflictResolution: "last-write-wins" },
                },
                tx
              );
            });
            return {
              clientOpId: op.clientOpId,
              status: "applied",
              message: "Version conflict resolved via last-write-wins (offline edit was newer).",
            };
          }

          // Server state is newer: hand the client the authoritative state to rebase against.
          await prisma.syncMutationLog.create({
            data: {
              clientOpId: op.clientOpId,
              userId: user.id,
              entityType: "Project",
              entityId: projectId,
              operation: "update",
              payload: JSON.parse(JSON.stringify(op.data)),
              conflict: true,
              conflictNote: `client expected v${expectedSyncVersion}, server at v${project.syncVersion}`,
            },
          });
          return {
            clientOpId: op.clientOpId,
            status: "conflict",
            message: "Server version is newer; local change was not applied.",
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

        await prisma.$transaction(async (tx) => {
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
              payload: JSON.parse(JSON.stringify(op.data)),
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
        });
        return { clientOpId: op.clientOpId, status: "applied" };
      }

      case "blocker.create": {
        const { projectId, title, description, severity, targetResolutionDate } = op.data;
        const project = await prisma.project.findFirst({
          where: { id: projectId, ...projectReadScope(user) },
        });
        if (!project) {
          return { clientOpId: op.clientOpId, status: "rejected", message: "Project not found" };
        }
        assertProjectWrite(user, project);

        await prisma.$transaction(async (tx) => {
          const blocker = await tx.blocker.create({
            data: {
              projectId,
              raisedById: user.id,
              title,
              description,
              severity,
              targetResolutionDate: targetResolutionDate ?? null,
              // Preserve the offline timestamp so SLA clocks start when the
              // blocker was actually raised, not when WAN came back.
              createdAt: op.occurredAt <= new Date() ? op.occurredAt : new Date(),
            },
          });
          await tx.syncMutationLog.create({
            data: {
              clientOpId: op.clientOpId,
              userId: user.id,
              entityType: "Blocker",
              entityId: blocker.id,
              operation: "create",
              payload: JSON.parse(JSON.stringify(op.data)),
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
        });
        await recalculateRag([projectId]);
        return { clientOpId: op.clientOpId, status: "applied" };
      }

      case "blocker.resolve": {
        const { blockerId, resolutionNotes } = op.data;
        const blocker = await prisma.blocker.findFirst({
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

        await prisma.$transaction(async (tx) => {
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
              payload: JSON.parse(JSON.stringify(op.data)),
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
        });
        await recalculateRag([blocker.projectId]);
        return { clientOpId: op.clientOpId, status: "applied" };
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
