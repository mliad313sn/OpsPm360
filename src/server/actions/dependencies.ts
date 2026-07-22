"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import {
  assertProjectWrite,
  projectReadScope,
  toActionError,
} from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { createDependencySchema } from "@/lib/validators";
import { wouldCreateCycle } from "@/lib/graph";
import { type ActionResult } from "@/server/actions/projects";
import { recalculateRag } from "@/server/rag-service";
import { withSystemDb, withUserDb } from "@/server/db";

/**
 * Cross-project dependency edges (project-level DAG).
 *
 * Permission model: the caller needs WRITE access on the successor (their
 * project is the one being gated) and READ visibility of the predecessor.
 * The cycle check runs against the FULL tenant graph inside the same system
 * transaction as the insert — two sites adding halves of a cycle offline
 * cannot both land: the second one is rejected with CIRCULAR_DEPENDENCY.
 */

export async function createDependencyAction(
  raw: unknown
): Promise<ActionResult<{ dependencyId: string }>> {
  try {
    const user = await requireSession();
    const input = createDependencySchema.parse(raw);

    // Phase 1 — tenant-scoped permission checks.
    const checked = await withUserDb(user, async (tx) => {
      const successor = await tx.project.findFirst({
        where: { id: input.successorProjectId, ...projectReadScope(user) },
      });
      if (!successor) return { error: "Successor project not found" };
      assertProjectWrite(user, successor);

      const predecessor = await tx.project.findFirst({
        where: { id: input.predecessorProjectId, ...projectReadScope(user) },
        select: { id: true, siteId: true, code: true },
      });
      if (!predecessor) return { error: "Predecessor project not found or not visible to you" };

      return {
        isCrossSite:
          successor.siteId !== null &&
          predecessor.siteId !== null &&
          successor.siteId !== predecessor.siteId,
      };
    });
    if (checked.error !== undefined) return { ok: false, error: checked.error };

    // Phase 2 — full-graph cycle check + insert, atomically (system context:
    // the DAG spans sites, so a site-scoped view could hide half a cycle).
    const outcome = await withSystemDb(async (tx) => {
      const edges = await tx.projectDependency.findMany({
        select: { predecessorProjectId: true, successorProjectId: true },
      });
      const cycle = wouldCreateCycle(
        edges.map((e) => ({ from: e.predecessorProjectId, to: e.successorProjectId })),
        { from: input.predecessorProjectId, to: input.successorProjectId }
      );
      if (cycle) {
        return { error: "CIRCULAR_DEPENDENCY: this link would create a loop in the portfolio graph" };
      }

      const existing = await tx.projectDependency.findUnique({
        where: {
          predecessorProjectId_successorProjectId: {
            predecessorProjectId: input.predecessorProjectId,
            successorProjectId: input.successorProjectId,
          },
        },
      });
      if (existing) return { error: "This dependency already exists" };

      const dep = await tx.projectDependency.create({
        data: {
          predecessorProjectId: input.predecessorProjectId,
          successorProjectId: input.successorProjectId,
          dependencyType: input.dependencyType,
          lagDays: input.lagDays,
          isCrossSite: checked.isCrossSite ?? false,
          createdById: user.id,
        },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "CREATE",
          entityType: "ProjectDependency",
          entityId: dep.id,
          next: {
            predecessorProjectId: input.predecessorProjectId,
            successorProjectId: input.successorProjectId,
            dependencyType: input.dependencyType,
            lagDays: input.lagDays,
          },
        },
        tx
      );
      return { dependencyId: dep.id };
    });
    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await recalculateRag([input.successorProjectId]);
    revalidatePath(`/projects/${input.successorProjectId}`);
    revalidatePath(`/projects/${input.predecessorProjectId}`);
    revalidatePath("/meeting");
    return { ok: true, data: { dependencyId: outcome.dependencyId } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteDependencyAction(rawId: string): Promise<ActionResult> {
  try {
    const user = await requireSession();
    const dependencyId = z.string().cuid().parse(rawId);

    const outcome = await withUserDb(user, async (tx) => {
      const dep = await tx.projectDependency.findUnique({
        where: { id: dependencyId },
        include: { successorProject: true },
      });
      if (!dep) return { error: "Dependency not found" };
      // Deleting requires write access on the gated (successor) project.
      assertProjectWrite(user, dep.successorProject);

      await tx.projectDependency.delete({ where: { id: dep.id } });
      await writeAudit(
        {
          userId: user.id,
          action: "DELETE",
          entityType: "ProjectDependency",
          entityId: dep.id,
          previous: {
            predecessorProjectId: dep.predecessorProjectId,
            successorProjectId: dep.successorProjectId,
          },
        },
        tx
      );
      return { successorId: dep.successorProjectId };
    });
    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    revalidatePath(`/projects/${outcome.successorId}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}
