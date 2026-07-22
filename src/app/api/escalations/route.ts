import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { writeAudit } from "@/lib/audit";
import { runSlaSweep } from "@/lib/sla";
import { notifyEscalation } from "@/lib/notify";
import { recalculateRag } from "@/server/rag-service";
import { notifyProjectRaci } from "@/server/raci-notify";
import { withSystemDb } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * Blocker SLA escalation sweep (Gate 3 workflow).
 *
 * Invoked by an external scheduler (Vercel Cron / K8s CronJob / GitHub Action)
 * every 15 minutes with `Authorization: Bearer $CRON_SECRET`.
 *
 * Ladder: 48h -> GROUP_IT_MANAGER, 120h -> GROUP_CIO. Idempotent by design —
 * the pure sweep only emits decisions for blockers below their target level.
 */

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function runSweepRequest(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const openBlockers = await withSystemDb((db) =>
    db.blocker.findMany({
      where: { status: { not: "RESOLVED" } },
      select: {
        id: true,
        status: true,
        escalationLevel: true,
        createdAt: true,
        projectId: true,
        title: true,
        project: { select: { code: true } },
      },
    })
  );

  const decisions = runSlaSweep(openBlockers);
  const affectedProjects = new Set<string>();

  for (const decision of decisions) {
    const blocker = openBlockers.find((b) => b.id === decision.blockerId);
    if (!blocker) continue;

    await withSystemDb(async (tx) => {
      await tx.blocker.update({
        where: { id: decision.blockerId },
        data: {
          escalationLevel: decision.to,
          status: "ESCALATED",
          lastEscalatedAt: new Date(),
        },
      });
      await writeAudit(
        {
          userId: null, // system actor
          action: "ESCALATION",
          entityType: "Blocker",
          entityId: decision.blockerId,
          previous: { escalationLevel: decision.from },
          next: { escalationLevel: decision.to, reason: decision.reason },
        },
        tx
      );
    });
    affectedProjects.add(blocker.projectId);

    await notifyEscalation({
      blockerId: blocker.id,
      blockerTitle: blocker.title,
      projectCode: blocker.project.code,
      from: decision.from,
      to: decision.to,
      reason: decision.reason,
    });

    // RACI email with a deep link straight to the escalated blocker.
    await notifyProjectRaci({
      projectId: blocker.projectId,
      headline: `Blocker escalated to ${decision.to.replaceAll("_", " ")}: ${blocker.title}`,
      detailLines: [decision.reason],
      ctaLabel: "Review blocker",
      deepLink: { entityType: "BLOCKER", entityId: blocker.id, projectId: blocker.projectId },
    });
  }

  // Escalations change blocker ages/levels — refresh RAG for touched projects.
  if (affectedProjects.size > 0) {
    await recalculateRag([...affectedProjects]);
  }

  return NextResponse.json({
    swept: openBlockers.length,
    escalated: decisions.map((d) => ({
      blockerId: d.blockerId,
      from: d.from,
      to: d.to,
      reason: d.reason,
    })),
  });
}

/** Vercel Cron invokes with GET; other schedulers may POST. Both are supported. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return runSweepRequest(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return runSweepRequest(req);
}
