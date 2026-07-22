"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import {
  assertProjectWrite,
  assertSteeringAuthority,
  projectReadScope,
  toActionError,
} from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { createScopeChangeSchema, decideScopeChangeSchema } from "@/lib/validators";
import { type ActionResult } from "@/server/actions/projects";

export async function createScopeChangeAction(
  raw: unknown
): Promise<ActionResult<{ requestId: string }>> {
  try {
    const user = await requireSession();
    const input = createScopeChangeSchema.parse(raw);

    const project = await prisma.project.findFirst({
      where: { id: input.projectId, ...projectReadScope(user) },
    });
    if (!project) return { ok: false, error: "Project not found" };
    assertProjectWrite(user, project);

    const request = await prisma.$transaction(async (tx) => {
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
      return created;
    });

    revalidatePath(`/projects/${project.id}`);
    return { ok: true, data: { requestId: request.id } };
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

    const request = await prisma.scopeChangeRequest.findFirst({
      where: { id: input.requestId, project: projectReadScope(user) },
      include: { project: { include: { financials: true } } },
    });
    if (!request) return { ok: false, error: "Scope change request not found" };
    if (request.status !== "PENDING") {
      return { ok: false, error: `Request already ${request.status.toLowerCase()}` };
    }

    await prisma.$transaction(async (tx) => {
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
        // Apply schedule impact.
        const newTargetEnd = new Date(
          request.project.targetEndDate.getTime() + request.timeImpactDays * 86_400_000
        );
        await tx.project.update({
          where: { id: request.projectId },
          data: { targetEndDate: newTargetEnd, syncVersion: { increment: 1 } },
        });

        // Apply budget impact to CapEx baseline (scope deltas are capital by policy).
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
    });

    revalidatePath(`/projects/${request.projectId}`);
    revalidatePath("/meeting");
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}
