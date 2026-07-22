"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import { assertProjectWrite, projectReadScope, toActionError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { createBlockerSchema, resolveBlockerSchema } from "@/lib/validators";
import { recalculateRag, type ActionResult } from "@/server/actions/projects";

export async function createBlockerAction(
  raw: unknown
): Promise<ActionResult<{ blockerId: string }>> {
  try {
    const user = await requireSession();
    const input = createBlockerSchema.parse(raw);

    const project = await prisma.project.findFirst({
      where: { id: input.projectId, ...projectReadScope(user) },
    });
    if (!project) return { ok: false, error: "Project not found" };
    assertProjectWrite(user, project);

    const blocker = await prisma.$transaction(async (tx) => {
      const created = await tx.blocker.create({
        data: {
          projectId: project.id,
          raisedById: user.id,
          title: input.title,
          description: input.description,
          severity: input.severity,
          targetResolutionDate: input.targetResolutionDate ?? null,
        },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "CREATE",
          entityType: "Blocker",
          entityId: created.id,
          next: { projectId: project.id, title: input.title, severity: input.severity },
        },
        tx
      );
      return created;
    });

    await recalculateRag([project.id]);
    revalidatePath(`/projects/${project.id}`);
    revalidatePath("/meeting");
    return { ok: true, data: { blockerId: blocker.id } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function resolveBlockerAction(raw: unknown): Promise<ActionResult> {
  try {
    const user = await requireSession();
    const input = resolveBlockerSchema.parse(raw);

    const blocker = await prisma.blocker.findFirst({
      where: { id: input.blockerId, project: projectReadScope(user) },
      include: { project: true },
    });
    if (!blocker) return { ok: false, error: "Blocker not found" };
    assertProjectWrite(user, blocker.project);

    if (blocker.status === "RESOLVED") {
      return { ok: false, error: "Blocker is already resolved" };
    }

    await prisma.$transaction(async (tx) => {
      await tx.blocker.update({
        where: { id: blocker.id },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          resolutionNotes: input.resolutionNotes,
        },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "UPDATE",
          entityType: "Blocker",
          entityId: blocker.id,
          previous: { status: blocker.status, escalationLevel: blocker.escalationLevel },
          next: { status: "RESOLVED", resolutionNotes: input.resolutionNotes },
        },
        tx
      );
    });

    await recalculateRag([blocker.projectId]);
    revalidatePath(`/projects/${blocker.projectId}`);
    revalidatePath("/meeting");
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}
