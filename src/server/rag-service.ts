import "server-only";

import { writeAudit } from "@/lib/audit";
import { computeRag, type Rag } from "@/lib/rag";
import { computeEva } from "@/lib/finance";
import { withSystemDb } from "@/server/db";

/**
 * Recompute ragCalculated for a set of projects (or all non-completed).
 *
 * Deliberately NOT in a "use server" module: every export of an actions file
 * becomes a client-invokable endpoint, and this system routine must only be
 * callable from trusted server code (actions, sync route, SLA sweep).
 *
 * Feeds earned-value efficiency (CPI/SPI) into the RAG engine so a project
 * burning money or schedule faster than it earns value cannot stay GREEN.
 */
export async function recalculateRag(projectIds?: string[]): Promise<number> {
  return withSystemDb(async (db) => {
    const projects = await db.project.findMany({
      where: projectIds ? { id: { in: projectIds } } : { status: { notIn: ["COMPLETED"] } },
      include: { milestones: true, blockers: true, financials: true, risks: true },
    });

    const now = new Date();
    let changed = 0;

    for (const p of projects) {
      const totalBudgetUSD = p.financials
        ? Number(p.financials.capexBudgetUSD) + Number(p.financials.opexBudgetUSD)
        : 0;
      const totalActualUSD = p.financials
        ? Number(p.financials.capexActualUSD) + Number(p.financials.opexActualUSD)
        : 0;

      const eva = computeEva(
        {
          budgetAtCompletionUSD: totalBudgetUSD,
          actualCostUSD: totalActualUSD,
          milestones: p.milestones.map((m) => ({
            targetDate: m.targetDate,
            completed: m.status === "COMPLETED",
            weightPercent: m.weightPercent,
          })),
        },
        now
      );

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
          financials: p.financials ? { totalBudgetUSD, totalActualUSD } : null,
          eva: { cpi: eva.cpi, spi: eva.spi },
          risks: p.risks.map((r) => ({
            score: r.probability * r.impact,
            status: r.status,
            hasMitigation: Boolean(r.mitigation && r.mitigation.trim().length > 0),
            potentialLossUSD: Number(r.potentialLossUSD),
          })),
        },
        now
      );

      if (result.rag !== p.ragCalculated) {
        await db.project.update({
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
          db
        );
        changed += 1;
      }
    }

    return changed;
  });
}
