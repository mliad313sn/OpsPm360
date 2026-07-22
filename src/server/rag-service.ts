import "server-only";

import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { computeRag, type Rag } from "@/lib/rag";

/**
 * Recompute ragCalculated for a set of projects (or all non-completed).
 *
 * Deliberately NOT in a "use server" module: every export of an actions file
 * becomes a client-invokable endpoint, and this system routine must only be
 * callable from trusted server code (actions, sync route, SLA sweep).
 */
export async function recalculateRag(projectIds?: string[]): Promise<number> {
  const projects = await prisma.project.findMany({
    where: projectIds ? { id: { in: projectIds } } : { status: { notIn: ["COMPLETED"] } },
    include: { milestones: true, blockers: true, financials: true },
  });

  const now = new Date();
  let changed = 0;

  for (const p of projects) {
    const fin = p.financials
      ? {
          totalBudgetUSD:
            Number(p.financials.capexBudgetUSD) + Number(p.financials.opexBudgetUSD),
          totalActualUSD:
            Number(p.financials.capexActualUSD) + Number(p.financials.opexActualUSD),
        }
      : null;

    const result = computeRag(
      {
        milestones: p.milestones.map((m) => ({
          targetDate: m.targetDate,
          actualDate: m.actualDate,
          status: m.status,
          weightPercent: m.weightPercent,
        })),
        blockers: p.blockers.map((b) => ({
          severity: b.severity,
          status: b.status,
          createdAt: b.createdAt,
        })),
        financials: fin,
      },
      now
    );

    if (result.rag !== p.ragCalculated) {
      await prisma.$transaction(async (tx) => {
        await tx.project.update({
          where: { id: p.id },
          data: { ragCalculated: result.rag as Rag },
        });
        await writeAudit(
          {
            userId: null, // system actor
            action: "UPDATE",
            entityType: "Project",
            entityId: p.id,
            previous: { ragCalculated: p.ragCalculated },
            next: { ragCalculated: result.rag, reasons: result.reasons },
          },
          tx
        );
      });
      changed += 1;
    }
  }

  return changed;
}
