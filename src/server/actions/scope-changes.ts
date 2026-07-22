"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth";
import {
  assertProjectWrite,
  assertSteeringAuthority,
  projectReadScope,
  toActionError,
} from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { createScopeChangeSchema, decideScopeChangeSchema } from "@/lib/validators";
import { downstreamOf } from "@/lib/graph";
import { type ActionResult } from "@/server/actions/projects";
import { recalculateRag } from "@/server/rag-service";
import { withSystemDb, withUserDb } from "@/server/db";

export async function createScopeChangeAction(
  raw: unknown
): Promise<ActionResult<{ requestId: string }>> {
  try {
    const user = await requireSession();
    const input = createScopeChangeSchema.parse(raw);

    const outcome = await withUserDb(user, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: input.projectId, ...projectReadScope(user) },
      });
      if (!project) return null;
      assertProjectWrite(user, project);

      const created = await tx.scopeChangeRequest.create({
        data: {
          projectId: project.id,
          requestedById: user.id,
          scopeDeltaDescription: input.scopeDeltaDescription,
          budgetImpactUSD: input.budgetImpactUSD,
          timeImpactDays: input.timeImpactDays,
        },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "SCOPE_CHANGE",
          entityType: "ScopeChangeRequest",
          entityId: created.id,
          next: {
            projectId: project.id,
            budgetImpactUSD: input.budgetImpactUSD,
            timeImpactDays: input.timeImpactDays,
          },
        },
        tx
      );
      return { requestId: created.id, projectId: project.id };
    });

    if (!outcome) return { ok: false, error: "Project not found" };

    revalidatePath(`/projects/${outcome.projectId}`);
    return { ok: true, data: { requestId: outcome.requestId } };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Approve/reject a scope change. Approval atomically applies the budget and
 * schedule impact to the project's financial baseline and target end date.
 */
export async function decideScopeChangeAction(raw: unknown): Promise<ActionResult> {
  try {
    const user = await requireSession();
    assertSteeringAuthority(user);
    const input = decideScopeChangeSchema.parse(raw);

    const outcome = await withUserDb(user, async (tx) => {
      const request = await tx.scopeChangeRequest.findFirst({
        where: { id: input.requestId, project: projectReadScope(user) },
        include: { project: { include: { financials: true } } },
      });
      if (!request) return { error: "Scope change request not found" };
      if (request.status !== "PENDING") {
        return { error: `Request already ${request.status.toLowerCase()}` };
      }

      await tx.scopeChangeRequest.update({
        where: { id: request.id },
        data: {
          status: input.approve ? "APPROVED" : "REJECTED",
          approvedById: user.id,
          decidedAt: new Date(),
          decisionNotes: input.decisionNotes ?? null,
        },
      });

      if (input.approve) {
        const newTargetEnd = new Date(
          request.project.targetEndDate.getTime() + request.timeImpactDays * 86_400_000
        );
        await tx.project.update({
          where: { id: request.projectId },
          data: { targetEndDate: newTargetEnd, syncVersion: { increment: 1 } },
        });

        if (request.project.financials) {
          const impact = new Prisma.Decimal(request.budgetImpactUSD);
          const newCapex = request.project.financials.capexBudgetUSD.add(impact);
          if (newCapex.isNegative()) {
            throw new Error("Scope change would drive CapEx budget below zero");
          }
          await tx.projectFinancials.update({
            where: { projectId: request.projectId },
            data: { capexBudgetUSD: newCapex },
          });
          await writeAudit(
            {
              userId: user.id,
              action: "BUDGET_CHANGE",
              entityType: "ProjectFinancials",
              entityId: request.project.financials.id,
              previous: { capexBudgetUSD: request.project.financials.capexBudgetUSD },
              next: { capexBudgetUSD: newCapex },
            },
            tx
          );
        }
      }

      await writeAudit(
        {
          userId: user.id,
          action: "SCOPE_CHANGE",
          entityType: "ScopeChangeRequest",
          entityId: request.id,
          previous: { status: "PENDING" },
          next: {
            status: input.approve ? "APPROVED" : "REJECTED",
            decisionNotes: input.decisionNotes ?? null,
          },
        },
        tx
      );
      return { projectId: request.projectId, timeImpactDays: request.timeImpactDays };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    // Dependency cascade: an approved schedule shift ripples to downstream
    // projects — their RAG is refreshed and the dependency rail surfaces the
    // impact. Dates of downstream projects are NOT auto-shifted: gate
    // governance requires each successor to accept its own re-baseline.
    if (input.approve && outcome.timeImpactDays !== 0) {
      const edges = await withSystemDb((db) =>
        db.projectDependency.findMany({
          select: { predecessorProjectId: true, successorProjectId: true },
        })
      );
      const affected = downstreamOf(
        edges.map((e) => ({ from: e.predecessorProjectId, to: e.successorProjectId })),
        outcome.projectId
      );
      if (affected.length > 0) {
        await recalculateRag(affected);
      }
    }

    revalidatePath(`/projects/${outcome.projectId}`);
    revalidatePath("/meeting");
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}
