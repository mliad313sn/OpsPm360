import "server-only";

import { prisma } from "@/lib/prisma";
import { projectReadScope } from "@/lib/rbac";
import { effectiveRag, type Rag } from "@/lib/rag";
import { computeVariance } from "@/lib/finance";
import type { SessionUser } from "@/lib/auth";

/** Read-model row shared by dashboard, war room, and offline cache seeding. */
export interface PortfolioRow {
  id: string;
  code: string;
  title: string;
  description: string;
  scopeType: "GROUP" | "SITE";
  siteId: string | null;
  siteName: string | null;
  ownerName: string;
  status: string;
  currentGate: string;
  ragCalculated: Rag;
  ragOverride: Rag | null;
  rag: Rag;
  ragOverrideReason: string | null;
  syncVersion: number;
  startDate: Date;
  targetEndDate: Date;
  totalBudgetUSD: number;
  totalActualUSD: number;
  varianceUSD: number;
  variancePct: number | null;
  openBlockerCount: number;
  criticalBlockerCount: number;
  pendingScopeChanges: number;
}

export async function fetchPortfolio(user: SessionUser): Promise<PortfolioRow[]> {
  const projects = await prisma.project.findMany({
    where: projectReadScope(user),
    include: {
      site: { select: { name: true } },
      owner: { select: { name: true } },
      financials: true,
      blockers: { where: { status: { not: "RESOLVED" } }, select: { severity: true } },
      scopeChanges: { where: { status: "PENDING" }, select: { id: true } },
    },
    orderBy: [{ ragCalculated: "asc" }, { code: "asc" }],
  });

  return projects.map((p) => {
    const fin = p.financials
      ? computeVariance({
          capexBudgetUSD: Number(p.financials.capexBudgetUSD),
          opexBudgetUSD: Number(p.financials.opexBudgetUSD),
          capexActualUSD: Number(p.financials.capexActualUSD),
          opexActualUSD: Number(p.financials.opexActualUSD),
          localCurrency: p.financials.localCurrency,
          fxRateToBase: Number(p.financials.fxRateToBase),
        })
      : null;

    return {
      id: p.id,
      code: p.code,
      title: p.title,
      description: p.description,
      scopeType: p.scopeType,
      siteId: p.siteId,
      siteName: p.site?.name ?? null,
      ownerName: p.owner.name,
      status: p.status,
      currentGate: p.currentGate,
      ragCalculated: p.ragCalculated,
      ragOverride: p.ragOverride,
      rag: effectiveRag(p.ragCalculated, p.ragOverride),
      ragOverrideReason: p.ragOverrideReason,
      syncVersion: p.syncVersion,
      startDate: p.startDate,
      targetEndDate: p.targetEndDate,
      totalBudgetUSD: fin?.totalBudgetUSD ?? 0,
      totalActualUSD: fin?.totalActualUSD ?? 0,
      varianceUSD: fin?.varianceUSD ?? 0,
      variancePct: fin?.variancePct ?? null,
      openBlockerCount: p.blockers.length,
      criticalBlockerCount: p.blockers.filter((b) => b.severity === "CRITICAL").length,
      pendingScopeChanges: p.scopeChanges.length,
    };
  });
}

export interface ProjectDetail extends PortfolioRow {
  milestones: {
    id: string;
    title: string;
    targetDate: Date;
    actualDate: Date | null;
    status: string;
    weightPercent: number;
  }[];
  blockers: {
    id: string;
    title: string;
    description: string;
    severity: string;
    status: string;
    escalationLevel: string;
    createdAt: Date;
    raisedByName: string;
  }[];
  scopeChangeRequests: {
    id: string;
    scopeDeltaDescription: string;
    budgetImpactUSD: number;
    timeImpactDays: number;
    status: string;
    requestedByName: string;
    createdAt: Date;
  }[];
  financialDetail: {
    capexBudgetUSD: number;
    opexBudgetUSD: number;
    capexActualUSD: number;
    opexActualUSD: number;
    localCurrency: "USD" | "EUR" | "XOF";
    fxRateToBase: number;
    sapWBSElement: string | null;
  } | null;
}

export async function fetchProjectDetail(
  user: SessionUser,
  projectId: string
): Promise<ProjectDetail | null> {
  const p = await prisma.project.findFirst({
    where: { id: projectId, ...projectReadScope(user) },
    include: {
      site: { select: { name: true } },
      owner: { select: { name: true } },
      financials: true,
      milestones: { orderBy: { targetDate: "asc" } },
      blockers: {
        include: { raisedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
      scopeChanges: {
        include: { requestedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!p) return null;

  const fin = p.financials
    ? computeVariance({
        capexBudgetUSD: Number(p.financials.capexBudgetUSD),
        opexBudgetUSD: Number(p.financials.opexBudgetUSD),
        capexActualUSD: Number(p.financials.capexActualUSD),
        opexActualUSD: Number(p.financials.opexActualUSD),
        localCurrency: p.financials.localCurrency,
        fxRateToBase: Number(p.financials.fxRateToBase),
      })
    : null;

  const openBlockers = p.blockers.filter((b) => b.status !== "RESOLVED");

  return {
    id: p.id,
    code: p.code,
    title: p.title,
    description: p.description,
    scopeType: p.scopeType,
    siteId: p.siteId,
    siteName: p.site?.name ?? null,
    ownerName: p.owner.name,
    status: p.status,
    currentGate: p.currentGate,
    ragCalculated: p.ragCalculated,
    ragOverride: p.ragOverride,
    rag: effectiveRag(p.ragCalculated, p.ragOverride),
    ragOverrideReason: p.ragOverrideReason,
    syncVersion: p.syncVersion,
    startDate: p.startDate,
    targetEndDate: p.targetEndDate,
    totalBudgetUSD: fin?.totalBudgetUSD ?? 0,
    totalActualUSD: fin?.totalActualUSD ?? 0,
    varianceUSD: fin?.varianceUSD ?? 0,
    variancePct: fin?.variancePct ?? null,
    openBlockerCount: openBlockers.length,
    criticalBlockerCount: openBlockers.filter((b) => b.severity === "CRITICAL").length,
    pendingScopeChanges: p.scopeChanges.filter((s) => s.status === "PENDING").length,
    milestones: p.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      targetDate: m.targetDate,
      actualDate: m.actualDate,
      status: m.status,
      weightPercent: m.weightPercent,
    })),
    blockers: p.blockers.map((b) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      severity: b.severity,
      status: b.status,
      escalationLevel: b.escalationLevel,
      createdAt: b.createdAt,
      raisedByName: b.raisedBy.name,
    })),
    scopeChangeRequests: p.scopeChanges.map((s) => ({
      id: s.id,
      scopeDeltaDescription: s.scopeDeltaDescription,
      budgetImpactUSD: Number(s.budgetImpactUSD),
      timeImpactDays: s.timeImpactDays,
      status: s.status,
      requestedByName: s.requestedBy.name,
      createdAt: s.createdAt,
    })),
    financialDetail: p.financials
      ? {
          capexBudgetUSD: Number(p.financials.capexBudgetUSD),
          opexBudgetUSD: Number(p.financials.opexBudgetUSD),
          capexActualUSD: Number(p.financials.capexActualUSD),
          opexActualUSD: Number(p.financials.opexActualUSD),
          localCurrency: p.financials.localCurrency,
          fxRateToBase: Number(p.financials.fxRateToBase),
          sapWBSElement: p.financials.sapWBSElement,
        }
      : null,
  };
}
