/**
 * Algorithmic RAG Health Score Engine (SRS Module 5).
 *
 * H = 100 * (0.40 * scheduleHealth + 0.35 * budgetHealth + 0.25 * blockerHealth)
 * Each component is normalized to [0, 1]; H is reported on the [0, 100] scale.
 *
 * Bands:  GREEN H >= 80  ·  AMBER 60 <= H < 80  ·  RED H < 60
 *
 * Hard rules (applied after the banded score, worst outcome wins):
 *  - Milestone delayed > 14 days        -> at best AMBER
 *  - Budget variance  > 10% over budget -> at best AMBER
 *  - Budget variance  > 20% over budget -> RED
 *  - CRITICAL blocker open > 7 days     -> RED
 */

export type Rag = "RED" | "AMBER" | "GREEN";

export interface MilestoneInput {
  targetDate: Date;
  actualDate: Date | null;
  status: "PENDING" | "COMPLETED" | "DELAYED";
  weightPercent: number;
}

export interface BlockerInput {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  status: "OPEN" | "ESCALATED" | "RESOLVED";
  createdAt: Date;
}

export interface FinancialInput {
  totalBudgetUSD: number;
  totalActualUSD: number;
}

export interface RagResult {
  rag: Rag;
  /** Health score H on the [0, 100] scale (SRS: GREEN >= 80, AMBER >= 60, RED < 60). */
  score: number;
  scheduleHealth: number;
  budgetHealth: number;
  blockerHealth: number;
  reasons: string[];
}

const DAY_MS = 86_400_000;

const WEIGHT_SCHEDULE = 0.4;
const WEIGHT_BUDGET = 0.35;
const WEIGHT_BLOCKER = 0.25;

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Days a milestone is overdue relative to `now` (0 if on track or completed on time). */
function milestoneDelayDays(m: MilestoneInput, now: Date): number {
  const reference = m.status === "COMPLETED" && m.actualDate ? m.actualDate : now;
  if (m.status === "COMPLETED" && !m.actualDate) return 0;
  const delay = (reference.getTime() - m.targetDate.getTime()) / DAY_MS;
  return Math.max(0, delay);
}

/**
 * Schedule health: weight-averaged milestone punctuality.
 * A milestone loses health linearly, reaching 0 at 30 days of delay.
 * Projects with no milestones (or all zero weights) are treated as healthy —
 * schedule risk is unknown, not proven bad.
 */
export function computeScheduleHealth(
  milestones: readonly MilestoneInput[],
  now: Date
): { health: number; maxDelayDays: number } {
  if (milestones.length === 0) return { health: 1, maxDelayDays: 0 };

  let weightSum = 0;
  let weighted = 0;
  let maxDelayDays = 0;

  for (const m of milestones) {
    const weight = Math.max(0, m.weightPercent);
    const delay = milestoneDelayDays(m, now);
    maxDelayDays = Math.max(maxDelayDays, delay);
    const punctuality = clamp01(1 - delay / 30);
    weightSum += weight;
    weighted += weight * punctuality;
  }

  // Zero total weight (all weights 0/unset): fall back to unweighted average.
  if (weightSum === 0) {
    const avg =
      milestones.reduce((acc, m) => acc + clamp01(1 - milestoneDelayDays(m, now) / 30), 0) /
      milestones.length;
    return { health: clamp01(avg), maxDelayDays };
  }

  return { health: clamp01(weighted / weightSum), maxDelayDays };
}

/**
 * Budget health from spend variance.
 * variance = (actual - budget) / budget. Zero budget with zero spend is healthy;
 * zero budget with spend is fully unhealthy (division guarded).
 * Health degrades linearly from variance 0% to 30% over budget.
 */
export function computeBudgetHealth(fin: FinancialInput | null): {
  health: number;
  variancePct: number | null;
} {
  if (!fin) return { health: 1, variancePct: null };

  const budget = fin.totalBudgetUSD;
  const actual = fin.totalActualUSD;

  if (!Number.isFinite(budget) || !Number.isFinite(actual)) {
    return { health: 1, variancePct: null };
  }

  if (budget <= 0) {
    return actual > 0 ? { health: 0, variancePct: null } : { health: 1, variancePct: 0 };
  }

  const variance = (actual - budget) / budget;
  if (variance <= 0) return { health: 1, variancePct: variance * 100 };
  return { health: clamp01(1 - variance / 0.3), variancePct: variance * 100 };
}

/**
 * Blocker health: penalizes open blockers by severity and age.
 */
export function computeBlockerHealth(
  blockers: readonly BlockerInput[],
  now: Date
): { health: number; criticalOpenDays: number } {
  const open = blockers.filter((b) => b.status !== "RESOLVED");
  if (open.length === 0) return { health: 1, criticalOpenDays: 0 };

  const severityPenalty: Record<BlockerInput["severity"], number> = {
    CRITICAL: 0.5,
    HIGH: 0.3,
    MEDIUM: 0.15,
    LOW: 0.05,
  };

  let penalty = 0;
  let criticalOpenDays = 0;

  for (const b of open) {
    const ageDays = Math.max(0, (now.getTime() - b.createdAt.getTime()) / DAY_MS);
    // Age multiplier: 1x fresh, up to 2x at 14+ days.
    const ageFactor = 1 + Math.min(1, ageDays / 14);
    penalty += severityPenalty[b.severity] * ageFactor;
    if (b.severity === "CRITICAL") {
      criticalOpenDays = Math.max(criticalOpenDays, ageDays);
    }
  }

  return { health: clamp01(1 - penalty), criticalOpenDays };
}

function scoreToRag(h: number): Rag {
  if (h >= 80) return "GREEN";
  if (h >= 60) return "AMBER";
  return "RED";
}

function worst(a: Rag, b: Rag): Rag {
  const order: Record<Rag, number> = { RED: 0, AMBER: 1, GREEN: 2 };
  return order[a] <= order[b] ? a : b;
}

export function computeRag(
  input: {
    milestones: readonly MilestoneInput[];
    blockers: readonly BlockerInput[];
    financials: FinancialInput | null;
  },
  now: Date = new Date()
): RagResult {
  const reasons: string[] = [];

  const schedule = computeScheduleHealth(input.milestones, now);
  const budget = computeBudgetHealth(input.financials);
  const blocker = computeBlockerHealth(input.blockers, now);

  const score =
    100 *
    clamp01(
      WEIGHT_SCHEDULE * schedule.health +
        WEIGHT_BUDGET * budget.health +
        WEIGHT_BLOCKER * blocker.health
    );

  let rag = scoreToRag(score);

  // Hard governance rules — worst outcome wins.
  if (schedule.maxDelayDays > 14) {
    rag = worst(rag, "AMBER");
    reasons.push(`Milestone delayed ${Math.floor(schedule.maxDelayDays)}d (>14d) — at best AMBER`);
  }
  if (blocker.criticalOpenDays > 7) {
    rag = worst(rag, "RED");
    reasons.push(
      `CRITICAL blocker open ${Math.floor(blocker.criticalOpenDays)}d (>7d) — forced RED`
    );
  }
  if (budget.variancePct !== null && budget.variancePct > 20) {
    rag = worst(rag, "RED");
    reasons.push(`Budget variance ${budget.variancePct.toFixed(1)}% (>20%) — forced RED`);
  } else if (budget.variancePct !== null && budget.variancePct > 10) {
    rag = worst(rag, "AMBER");
    reasons.push(`Budget variance ${budget.variancePct.toFixed(1)}% (>10%) — at best AMBER`);
  }
  if (input.financials && input.financials.totalBudgetUSD <= 0 && input.financials.totalActualUSD > 0) {
    rag = worst(rag, "RED");
    reasons.push("Spend recorded against zero budget — forced RED");
  }

  if (reasons.length === 0) {
    reasons.push(`Weighted health score H=${score.toFixed(0)}/100`);
  }

  return {
    rag,
    score,
    scheduleHealth: schedule.health,
    budgetHealth: budget.health,
    blockerHealth: blocker.health,
    reasons,
  };
}

/** Effective RAG shown to users: manual override (with audit trail) beats calculated. */
export function effectiveRag(calculated: Rag, override: Rag | null | undefined): Rag {
  return override ?? calculated;
}
