"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth";
import {
  assertProjectCreate,
  assertProjectWrite,
  assertSteeringAuthority,
  projectReadScope,
  toActionError,
} from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { computeRag, type Rag } from "@/lib/rag";
import {
  advanceGateSchema,
  createProjectSchema,
  ragOverrideSchema,
  updateProjectSchema,
} from "@/lib/validators";
import { isGate, missingGateItems, nextGate } from "@/lib/gates";

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Generate the next project code, e.g. HND-2026-004 or GRP-2026-012. */
async function nextProjectCode(
  tx: Prisma.TransactionClient,
  scopeType: "GROUP" | "SITE",
  siteId: string | null,
  year: number
): Promise<string> {
  let prefix = "GRP";
  if (scopeType === "SITE" && siteId) {
    const site = await tx.site.findUnique({ where: { id: siteId }, select: { code: true } });
    prefix = site?.code ?? "SIT";
  }
  const count = await tx.project.count({
    where: { code: { startsWith: `${prefix}-${year}-` } },
  });
  return `${prefix}-${year}-${String(count + 1).padStart(3, "0")}`;
}

export async function createProjectAction(
  raw: unknown
): Promise<ActionResult<{ projectId: string; code: string }>> {
  try {
    const user = await requireSession();
    const input = createProjectSchema.parse(raw);
    assertProjectCreate(user, input.scopeType, input.siteId);

    const siteId = input.scopeType === "GROUP" ? null : input.siteId;

    const created = await prisma.$transaction(async (tx) => {
      const code = await nextProjectCode(tx, input.scopeType, siteId, input.startDate.getFullYear());

      const project = await tx.project.create({
        data: {
          code,
          title: input.title,
          description: input.description,
          scopeType: input.scopeType,
          siteId,
          ownerId: user.id,
          startDate: input.startDate,
          targetEndDate: input.targetEndDate,
          cobitChecklist: input.cobitChecklist,
          financials: {
            create: {
              capexBudgetUSD: input.financials.capexBudgetUSD,
              opexBudgetUSD: input.financials.opexBudgetUSD,
              localCurrency: input.financials.localCurrency,
              fxRateToBase: input.financials.fxRateToBase,
              sapWBSElement: input.financials.sapWBSElement ?? null,
            },
          },
          milestones: {
            create: input.milestones.map((m) => ({
              title: m.title,
              targetDate: m.targetDate,
              weightPercent: m.weightPercent,
            })),
          },
        },
      });

      await writeAudit(
        {
          userId: user.id,
          action: "CREATE",
          entityType: "Project",
          entityId: project.id,
          next: { code, title: input.title, scopeType: input.scopeType, siteId },
        },
        tx
      );

      return project;
    });

    revalidatePath("/");
    revalidatePath("/projects");
    return { ok: true, data: { projectId: created.id, code: created.code } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function updateProjectAction(raw: unknown): Promise<ActionResult> {
  try {
    const user = await requireSession();
    const input = updateProjectSchema.parse(raw);

    const project = await prisma.project.findFirst({
      where: { id: input.projectId, ...projectReadScope(user) },
    });
    if (!project) return { ok: false, error: "Project not found" };
    assertProjectWrite(user, project);

    // Optimistic concurrency: reject stale writes (offline clients rebase via /api/sync).
    if (project.syncVersion !== input.expectedSyncVersion) {
      return {
        ok: false,
        error: `Project was modified by someone else (v${project.syncVersion}). Refresh and retry.`,
      };
    }

    await prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id: project.id },
        data: { ...input.patch, syncVersion: { increment: 1 } },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "UPDATE",
          entityType: "Project",
          entityId: project.id,
          previous: {
            title: project.title,
            status: project.status,
            currentGate: project.currentGate,
            targetEndDate: project.targetEndDate,
          },
          next: {
            title: updated.title,
            status: updated.status,
            currentGate: updated.currentGate,
            targetEndDate: updated.targetEndDate,
          },
        },
        tx
      );
    });

    revalidatePath("/");
    revalidatePath(`/projects/${project.id}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * COBIT stage-gate advancement (SRS Module 2). The project only moves to the
 * next gate when every exit-checklist item of the CURRENT gate is confirmed.
 * The confirmed checklist snapshot is persisted and the transition audited.
 */
export async function advanceGateAction(
  raw: unknown
): Promise<ActionResult<{ newGate: string }>> {
  try {
    const user = await requireSession();
    const input = advanceGateSchema.parse(raw);

    const project = await prisma.project.findFirst({
      where: { id: input.projectId, ...projectReadScope(user) },
    });
    if (!project) return { ok: false, error: "Project not found" };
    assertProjectWrite(user, project);

    if (!isGate(project.currentGate)) {
      return { ok: false, error: `Unknown gate: ${project.currentGate}` };
    }
    const target = nextGate(project.currentGate);
    if (!target) return { ok: false, error: "Project is already CLOSED" };

    const missing = missingGateItems(project.currentGate, input.checklist);
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Gate exit blocked — outstanding items: ${missing.map((m) => m.label).join("; ")}`,
      };
    }

    const existingSnapshots: Record<string, unknown> =
      project.gateChecklists &&
      typeof project.gateChecklists === "object" &&
      !Array.isArray(project.gateChecklists)
        ? { ...(project.gateChecklists as Record<string, unknown>) }
        : {};
    const nextSnapshots = {
      ...existingSnapshots,
      [project.currentGate]: {
        answers: input.checklist,
        completedAt: new Date().toISOString(),
        byUserId: user.id,
      },
    } as Prisma.InputJsonValue;

    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: {
          currentGate: target,
          gateChecklists: nextSnapshots,
          syncVersion: { increment: 1 },
        },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "UPDATE",
          entityType: "Project",
          entityId: project.id,
          previous: { currentGate: project.currentGate },
          next: { currentGate: target, gateExitChecklist: input.checklist },
        },
        tx
      );
    });

    revalidatePath(`/projects/${project.id}`);
    revalidatePath("/");
    revalidatePath("/board");
    return { ok: true, data: { newGate: target } };
  } catch (err) {
    return toActionError(err);
  }
}

/** Steering-committee manual RAG override with mandatory reason + audit trail. */
export async function overrideRagAction(raw: unknown): Promise<ActionResult> {
  try {
    const user = await requireSession();
    assertSteeringAuthority(user);
    const input = ragOverrideSchema.parse(raw);

    const project = await prisma.project.findFirst({
      where: { id: input.projectId, ...projectReadScope(user) },
    });
    if (!project) return { ok: false, error: "Project not found" };

    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: {
          ragOverride: input.override,
          ragOverrideReason: input.override ? input.reason : null,
          ragOverrideById: input.override ? user.id : null,
          ragOverrideAt: input.override ? new Date() : null,
          syncVersion: { increment: 1 },
        },
      });
      await writeAudit(
        {
          userId: user.id,
          action: "RAG_OVERRIDE",
          entityType: "Project",
          entityId: project.id,
          previous: { ragOverride: project.ragOverride, reason: project.ragOverrideReason },
          next: { ragOverride: input.override, reason: input.override ? input.reason : null },
        },
        tx
      );
    });

    revalidatePath("/");
    revalidatePath("/meeting");
    revalidatePath(`/projects/${project.id}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Recompute ragCalculated for a set of projects (or all in caller's scope).
 * Called after mutations that affect health inputs, and by the SLA sweep.
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
