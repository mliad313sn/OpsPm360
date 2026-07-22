"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { assertProjectWrite, projectReadScope, toActionError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assignRaciSchema } from "@/lib/validators";
import { type ActionResult } from "@/server/actions/projects";
import { withUserDb } from "@/server/db";

/**
 * Project-level RACI matrix.
 *  - Exactly one Accountable (A) per project — assigning a new A replaces the
 *    old one atomically (a DB partial-unique index backs this invariant).
 *  - Assignees must be tenant-plausible: group-scoped users, or users of the
 *    project's own site.
 */

export async function assignRaciAction(raw: unknown): Promise<ActionResult> {
  try {
    const user = await requireSession();
    const input = assignRaciSchema.parse(raw);

    const outcome = await withUserDb(user, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: input.projectId, ...projectReadScope(user) },
      });
      if (!project) return { error: "Project not found" };
      assertProjectWrite(user, project);

      const assignee = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, name: true, role: true, siteId: true, isActive: true },
      });
      if (!assignee || !assignee.isActive) return { error: "Assignee not found" };
      const assigneeIsGroup = assignee.role !== "SITE_IT_LEAD";
      if (!assigneeIsGroup && project.siteId && assignee.siteId !== project.siteId) {
        return { error: "Assignee belongs to a different site than this project" };
      }

      if (input.role === "A") {
        // Single Accountable: replace any existing A in the same transaction.
        await tx.raciAssignment.deleteMany({
          where: { entityType: "PROJECT", entityId: project.id, role: "A" },
        });
      }

      await tx.raciAssignment.upsert({
        where: {
          entityType_entityId_userId_role: {
            entityType: "PROJECT",
            entityId: project.id,
            userId: input.userId,
            role: input.role,
          },
        },
        update: {},
        create: {
          entityType: "PROJECT",
          entityId: project.id,
          userId: input.userId,
          role: input.role,
        },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "UPDATE",
          entityType: "Project",
          entityId: project.id,
          next: { raciAssigned: { userId: input.userId, name: assignee.name, role: input.role } },
        },
        tx
      );
      return { projectId: project.id };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    revalidatePath(`/projects/${outcome.projectId}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeRaciAction(rawId: string): Promise<ActionResult> {
  try {
    const user = await requireSession();
    const assignmentId = z.string().cuid().parse(rawId);

    const outcome = await withUserDb(user, async (tx) => {
      const assignment = await tx.raciAssignment.findUnique({ where: { id: assignmentId } });
      if (!assignment || assignment.entityType !== "PROJECT") {
        return { error: "Assignment not found" };
      }
      const project = await tx.project.findFirst({
        where: { id: assignment.entityId, ...projectReadScope(user) },
      });
      if (!project) return { error: "Assignment not found" };
      assertProjectWrite(user, project);

      await tx.raciAssignment.delete({ where: { id: assignment.id } });
      await writeAudit(
        {
          userId: user.id,
          action: "UPDATE",
          entityType: "Project",
          entityId: project.id,
          previous: { raciRemoved: { userId: assignment.userId, role: assignment.role } },
        },
        tx
      );
      return { projectId: project.id };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    revalidatePath(`/projects/${outcome.projectId}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}

/** Users eligible for RACI on a project (group-scoped + same-site), for the picker. */
export async function listAssignableUsersAction(
  rawProjectId: string
): Promise<ActionResult<{ users: { id: string; name: string; role: string }[] }>> {
  try {
    const user = await requireSession();
    const projectId = z.string().cuid().parse(rawProjectId);

    const users = await withUserDb(user, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, ...projectReadScope(user) },
        select: { siteId: true },
      });
      if (!project) return null;
      return tx.user.findMany({
        where: {
          isActive: true,
          OR: [
            { role: { in: ["GROUP_IT_MANAGER", "SYSTEM_ADMIN", "EXEC_STAKEHOLDER"] } },
            ...(project.siteId ? [{ siteId: project.siteId }] : []),
          ],
        },
        select: { id: true, name: true, role: true },
        orderBy: { name: "asc" },
      });
    });

    if (!users) return { ok: false, error: "Project not found" };
    return { ok: true, data: { users } };
  } catch (err) {
    return toActionError(err);
  }
}
