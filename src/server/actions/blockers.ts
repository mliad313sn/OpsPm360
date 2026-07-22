"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { assertProjectWrite, projectReadScope, toActionError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { createBlockerSchema, resolveBlockerSchema } from "@/lib/validators";
import { type ActionResult } from "@/server/actions/projects";
import { recalculateRag } from "@/server/rag-service";
import { notifyProjectRaci } from "@/server/raci-notify";
import { withUserDb } from "@/server/db";

export async function createBlockerAction(
  raw: unknown
): Promise<ActionResult<{ blockerId: string }>> {
  try {
    const user = await requireSession();
    const input = createBlockerSchema.parse(raw);

    const outcome = await withUserDb(user, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: input.projectId, ...projectReadScope(user) },
      });
      if (!project) return null;
      assertProjectWrite(user, project);

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
      return { blockerId: created.id, projectId: project.id };
    });

    if (!outcome) return { ok: false, error: "Project not found" };

    await recalculateRag([outcome.projectId]);

    // T+0 RACI dispatch: the Accountable hears about a new blocker immediately,
    // with a deep link straight to the record.
    await notifyProjectRaci({
      projectId: outcome.projectId,
      headline: `New ${input.severity} blocker: ${input.title}`,
      detailLines: [input.description.slice(0, 300), "SLA clock started (48h → Group IT, 120h → CIO)."],
      ctaLabel: "Open blocker",
      deepLink: { entityType: "BLOCKER", entityId: outcome.blockerId, projectId: outcome.projectId },
    });

    revalidatePath(`/projects/${outcome.projectId}`);
    revalidatePath("/meeting");
    return { ok: true, data: { blockerId: outcome.blockerId } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function resolveBlockerAction(raw: unknown): Promise<ActionResult> {
  try {
    const user = await requireSession();
    const input = resolveBlockerSchema.parse(raw);

    const outcome = await withUserDb(user, async (tx) => {
      const blocker = await tx.blocker.findFirst({
        where: { id: input.blockerId, project: projectReadScope(user) },
        include: { project: true },
      });
      if (!blocker) return { error: "Blocker not found" };
      assertProjectWrite(user, blocker.project);

      if (blocker.status === "RESOLVED") {
        return { error: "Blocker is already resolved" };
      }

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
      return { projectId: blocker.projectId };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await recalculateRag([outcome.projectId]);
    revalidatePath(`/projects/${outcome.projectId}`);
    revalidatePath("/meeting");
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}
