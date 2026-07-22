import "server-only";

import { projectReadScope } from "@/lib/rbac";
import { withUserDb } from "@/server/db";
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
  // RLS floor (withUserDb) + app-level scope fragment = defense in depth.
  const projects = await withUserDb(user, (db) =>
    db.project.findMany({
      where: projectReadScope(user),
      include: {
        site: { select: { name: true } },
        owner: { select: { name: true } },
        financials: true,
        blockers: { where: { status: { not: "RESOLVED" } }, select: { severity: true } },
        scopeChanges: { where: { status: "PENDING" }, select: { id: true } },
      },
      orderBy: [{ ragCalculated: "asc" }, { code: "asc" }],
    })
  );

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

/** Recent-alert feed entries for the executive dashboard (design: Recent Alerts). */
export interface AlertItem {
  id: string;
  kind: "ESCALATION" | "RAG_OVERRIDE" | "SCOPE_PENDING" | "CRITICAL_BLOCKER";
  title: string;
  detail: string;
  at: Date;
  projectId: string;
}

export async function fetchAlerts(user: SessionUser, limit = 6): Promise<AlertItem[]> {
  const scope = projectReadScope(user);

  // Sequential within one RLS transaction (interactive tx clients are not
  // safe for concurrent use).
  const { escalated, overridden, pendingScope } = await withUserDb(user, async (db) => ({
    escalated: await db.blocker.findMany({
      where: { project: scope, status: { not: "RESOLVED" } },
      include: { project: { select: { id: true, code: true } } },
      orderBy: [{ lastEscalatedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: limit,
    }),
    overridden: await db.project.findMany({
      where: { ...scope, ragOverrideAt: { not: null } },
      select: {
        id: true,
        code: true,
        ragOverride: true,
        ragOverrideReason: true,
        ragOverrideAt: true,
      },
      orderBy: { ragOverrideAt: "desc" },
      take: limit,
    }),
    pendingScope: await db.scopeChangeRequest.findMany({
      where: { project: scope, status: "PENDING" },
      include: { project: { select: { id: true, code: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  }));

  const alerts: AlertItem[] = [
    ...escalated.map((b): AlertItem => ({
      id: `blk-${b.id}`,
      kind: b.lastEscalatedAt
        ? "ESCALATION"
        : b.severity === "CRITICAL"
          ? "CRITICAL_BLOCKER"
          : "ESCALATION",
      title: b.lastEscalatedAt
        ? `Escalated to ${b.escalationLevel.replaceAll("_", " ")}`
        : `${b.severity} blocker open`,
      detail: `${b.project.code}: ${b.title}`,
      at: b.lastEscalatedAt ?? b.createdAt,
      projectId: b.project.id,
    })),
    ...overridden.map((p): AlertItem => ({
      id: `ovr-${p.id}`,
      kind: "RAG_OVERRIDE",
      title: `RAG overridden to ${p.ragOverride ?? "?"}`,
      detail: `${p.code}: ${p.ragOverrideReason ?? ""}`,
      at: p.ragOverrideAt ?? new Date(0),
      projectId: p.id,
    })),
    ...pendingScope.map((s): AlertItem => ({
      id: `scp-${s.id}`,
      kind: "SCOPE_PENDING",
      title: "Scope change awaiting approval",
      detail: `${s.project.code}: ${Number(s.budgetImpactUSD) >= 0 ? "+" : ""}$${Math.round(
        Number(s.budgetImpactUSD) / 1000
      )}K / ${s.timeImpactDays >= 0 ? "+" : ""}${s.timeImpactDays}d`,
      at: s.createdAt,
      projectId: s.project.id,
    })),
  ];

  return alerts.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

// ─── War Room signals: top risks + cross-site dependency impacts ─────────────

export interface WarRoomSignals {
  topRisks: {
    id: string;
    projectCode: string;
    title: string;
    category: string;
    probability: number;
    impact: number;
    score: number;
    hasMitigation: boolean;
  }[];
  dependencyAlerts: {
    id: string;
    successorCode: string;
    predecessorCode: string | null; // null = upstream project not visible to caller
    predecessorRag: Rag | null;
    dependencyType: string;
    lagDays: number;
    isCrossSite: boolean;
  }[];
}

export async function fetchWarRoomSignals(user: SessionUser): Promise<WarRoomSignals> {
  return withUserDb(user, async (db) => {
    const topRisks = await db.risk.findMany({
      where: { status: { in: ["OPEN", "MITIGATING"] }, project: projectReadScope(user) },
      include: { project: { select: { code: true } } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    const scoped = await db.project.findMany({
      where: projectReadScope(user),
      select: { id: true, code: true, ragCalculated: true, ragOverride: true },
    });
    const byId = new Map(scoped.map((p) => [p.id, p]));

    const edges = await db.projectDependency.findMany();

    const dependencyAlerts = edges
      .filter((e) => byId.has(e.successorProjectId))
      .map((e) => {
        const successor = byId.get(e.successorProjectId);
        const predecessor = byId.get(e.predecessorProjectId);
        const predecessorRag = predecessor
          ? effectiveRag(predecessor.ragCalculated, predecessor.ragOverride)
          : null;
        return {
          id: e.id,
          successorCode: successor?.code ?? "?",
          predecessorCode: predecessor?.code ?? null,
          predecessorRag,
          dependencyType: e.dependencyType,
          lagDays: e.lagDays,
          isCrossSite: e.isCrossSite,
        };
      })
      // Alert-worthy: upstream at risk, or upstream invisible (cross-site, unknown state).
      .filter((a) => a.predecessorRag === null || a.predecessorRag !== "GREEN")
      .slice(0, 12);

    return {
      topRisks: topRisks
        .map((r) => ({
          id: r.id,
          projectCode: r.project.code,
          title: r.title,
          category: r.category,
          probability: r.probability,
          impact: r.impact,
          score: r.probability * r.impact,
          hasMitigation: Boolean(r.mitigation && r.mitigation.trim().length > 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8),
      dependencyAlerts,
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
  risks: {
    id: string;
    title: string;
    description: string;
    category: string;
    probability: number;
    impact: number;
    potentialLossUSD: number;
    mitigation: string | null;
    contingencyPlan: string | null;
    status: string;
    raisedByName: string;
  }[];
  upstreamDeps: {
    id: string;
    predecessorCode: string | null; // null = not visible to caller (cross-site)
    predecessorTitle: string | null;
    predecessorRag: Rag | null;
    dependencyType: string;
    lagDays: number;
    isCrossSite: boolean;
  }[];
  downstreamDepCount: number;
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
  return withUserDb(user, async (db) => {
    const p = await db.project.findFirst({
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
        risks: {
          include: { raisedBy: { select: { name: true } } },
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        },
        scopeChanges: {
          include: { requestedBy: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!p) return null;

    // Dependencies: edges selected as scalars, predecessors resolved through
    // the scoped Project policy (invisible cross-site predecessors → null).
    const [upEdges, downstreamDepCount] = [
      await db.projectDependency.findMany({ where: { successorProjectId: p.id } }),
      await db.projectDependency.count({ where: { predecessorProjectId: p.id } }),
    ];
    const predecessors = await db.project.findMany({
      where: { id: { in: upEdges.map((e) => e.predecessorProjectId) } },
      select: { id: true, code: true, title: true, ragCalculated: true, ragOverride: true },
    });
    const predById = new Map(predecessors.map((x) => [x.id, x]));

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
    risks: p.risks.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      category: r.category,
      probability: r.probability,
      impact: r.impact,
      potentialLossUSD: Number(r.potentialLossUSD),
      mitigation: r.mitigation,
      contingencyPlan: r.contingencyPlan,
      status: r.status,
      raisedByName: r.raisedBy.name,
    })),
    upstreamDeps: upEdges.map((e) => {
      const pred = predById.get(e.predecessorProjectId);
      return {
        id: e.id,
        predecessorCode: pred?.code ?? null,
        predecessorTitle: pred?.title ?? null,
        predecessorRag: pred ? effectiveRag(pred.ragCalculated, pred.ragOverride) : null,
        dependencyType: e.dependencyType,
        lagDays: e.lagDays,
        isCrossSite: e.isCrossSite,
      };
    }),
    downstreamDepCount,
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
  });
}
