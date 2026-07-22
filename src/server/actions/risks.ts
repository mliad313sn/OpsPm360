"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { assertProjectWrite, projectReadScope, toActionError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { createRiskSchema, updateRiskSchema } from "@/lib/validators";
import { type ActionResult } from "@/server/actions/projects";
import { recalculateRag } from "@/server/rag-service";
import { withUserDb } from "@/server/db";
import { riskBand, riskScore } from "@/lib/risk";

/**
 * Proactive risk register (PMBOK): probability × impact scoring, mitigation
 * tracking, and one-click conversion of a REALIZED risk into a live blocker
 * (which starts the SLA escalation clock).
 */

export async function createRiskAction(
  raw: unknown
): Promise<ActionResult<{ riskId: string }>> {
  try {
    const user = await requireSession();
    const input = createRiskSchema.parse(raw);

    const outcome = await withUserDb(user, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: input.projectId, ...projectReadScope(user) },
      });
      if (!project) return null;
      assertProjectWrite(user, project);

      const risk = await tx.risk.create({
        data: {
          projectId: project.id,
          raisedById: user.id,
          title: input.title,
          description: input.description,
          category: input.category,
          probability: input.probability,
          impact: input.impact,
          potentialLossUSD: input.potentialLossUSD,
          mitigation: input.mitigation ?? null,
          contingencyPlan: input.contingencyPlan ?? null,
        },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "CREATE",
          entityType: "Risk",
          entityId: risk.id,
          next: {
            projectId: project.id,
            title: input.title,
            category: input.category,
            probability: input.probability,
            impact: input.impact,
            score: riskScore(input.probability, input.impact),
            potentialLossUSD: input.potentialLossUSD,
          },
        },
        tx
      );
      return { riskId: risk.id, projectId: project.id };
    });

    if (!outcome) return { ok: false, error: "Project not found" };

    revalidatePath(`/projects/${outcome.projectId}`);
    return { ok: true, data: { riskId: outcome.riskId } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function updateRiskStatusAction(raw: unknown): Promise<ActionResult> {
  try {
    const user = await requireSession();
    const input = updateRiskSchema.parse(raw);

    const outcome = await withUserDb(user, async (tx) => {
      const risk = await tx.risk.findFirst({
        where: { id: input.riskId, project: projectReadScope(user) },
        include: { project: true },
      });
      if (!risk) return null;
      assertProjectWrite(user, risk.project);

      await tx.risk.update({
        where: { id: risk.id },
        data: { status: input.status, mitigation: input.mitigation ?? risk.mitigation },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "UPDATE",
          entityType: "Risk",
          entityId: risk.id,
          previous: { status: risk.status },
          next: { status: input.status, mitigation: input.mitigation ?? risk.mitigation },
        },
        tx
      );
      return { projectId: risk.projectId };
    });

    if (!outcome) return { ok: false, error: "Risk not found" };

    revalidatePath(`/projects/${outcome.projectId}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}

/** A risk that materialized becomes a blocker: SLA clock starts immediately. */
export async function realizeRiskAsBlockerAction(
  rawRiskId: string
): Promise<ActionResult<{ blockerId: string }>> {
  try {
    const user = await requireSession();
    const riskId = updateRiskSchema.shape.riskId.parse(rawRiskId);

    const outcome = await withUserDb(user, async (tx) => {
      const risk = await tx.risk.findFirst({
        where: { id: riskId, project: projectReadScope(user) },
        include: { project: true },
      });
      if (!risk) return { error: "Risk not found" };
      assertProjectWrite(user, risk.project);
      if (risk.status === "REALIZED" || risk.status === "CLOSED") {
        return { error: `Risk is already ${risk.status.toLowerCase()}` };
      }

      const severity = riskBand(riskScore(risk.probability, risk.impact));
      const blocker = await tx.blocker.create({
        data: {
          projectId: risk.projectId,
          raisedById: user.id,
          title: `[Realized risk] ${risk.title}`,
          description: `${risk.description}\n\nMitigation on file: ${risk.mitigation ?? "none"}`,
          severity,
        },
      });
      await tx.risk.update({
        where: { id: risk.id },
        data: { status: "REALIZED", materializedBlockerId: blocker.id },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "UPDATE",
          entityType: "Risk",
          entityId: risk.id,
          previous: { status: risk.status },
          next: { status: "REALIZED", convertedToBlockerId: blocker.id, severity },
        },
        tx
      );
      return { blockerId: blocker.id, projectId: risk.projectId };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await recalculateRag([outcome.projectId]);
    revalidatePath(`/projects/${outcome.projectId}`);
    revalidatePath("/meeting");
    return { ok: true, data: { blockerId: outcome.blockerId } };
  } catch (err) {
    return toActionError(err);
  }
}
