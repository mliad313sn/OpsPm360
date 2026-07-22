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

export interface EvaSignal {
  cpi: number | null; // EV/AC — cost efficiency
  spi: number | null; // EV/PV — schedule efficiency
}

/** Below this efficiency index the project cannot be GREEN (PMBOK practice). */
export const EVA_AMBER_THRESHOLD = 0.85;

export interface RiskInput {
  score: number; // probability × impact (1..25)
  status: "OPEN" | "MITIGATING" | "REALIZED" | "CLOSED";
  hasMitigation: boolean;
  potentialLossUSD: number;
}

/** ≥2 unmitigated high risks (score ≥15) force RED. */
export const UNMITIGATED_HIGH_RISK_RED_COUNT = 2;
/** Active risk exposure above 25% of budget caps health at AMBER. */
export const RISK_EXPOSURE_AMBER_RATIO = 0.25;

export function computeRag(
  input: {
    milestones: readonly MilestoneInput[];
    blockers: readonly BlockerInput[];
    financials: FinancialInput | null;
    eva?: EvaSignal;
    risks?: readonly RiskInput[];
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
  // Earned-value efficiency: burning money or time faster than value is
  // earned caps health at AMBER regardless of the subjective-looking score.
  const cpi = input.eva?.cpi ?? null;
  const spi = input.eva?.spi ?? null;
  if (cpi !== null && Number.isFinite(cpi) && cpi < EVA_AMBER_THRESHOLD) {
    rag = worst(rag, "AMBER");
    reasons.push(`CPI ${cpi.toFixed(2)} (<${EVA_AMBER_THRESHOLD}) — cost efficiency caps at AMBER`);
  }
  if (spi !== null && Number.isFinite(spi) && spi < EVA_AMBER_THRESHOLD) {
    rag = worst(rag, "AMBER");
    reasons.push(`SPI ${spi.toFixed(2)} (<${EVA_AMBER_THRESHOLD}) — schedule efficiency caps at AMBER`);
  }
  // Proactive risk posture (register hard rules).
  if (input.risks && input.risks.length > 0) {
    const active = input.risks.filter((r) => r.status === "OPEN" || r.status === "MITIGATING");
    const unmitigatedHigh = active.filter((r) => r.score >= 15 && !r.hasMitigation);
    if (unmitigatedHigh.length >= UNMITIGATED_HIGH_RISK_RED_COUNT) {
      rag = worst(rag, "RED");
      reasons.push(
        `${unmitigatedHigh.length} unmitigated high risks (score ≥15) — forced RED`
      );
    }
    if (input.financials && input.financials.totalBudgetUSD > 0) {
      const exposure = active.reduce(
        (acc, r) =>
          acc + (Number.isFinite(r.potentialLossUSD) ? Math.max(0, r.potentialLossUSD) : 0),
        0
      );
      const ratio = exposure / input.financials.totalBudgetUSD;
      if (ratio > RISK_EXPOSURE_AMBER_RATIO) {
        rag = worst(rag, "AMBER");
        reasons.push(
          `Risk exposure ${(ratio * 100).toFixed(0)}% of budget (>25%) — at best AMBER`
        );
      }
    }
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

// ─── Portfolio rollup (Tier-1 upgrade) ───────────────────────────────────────

const BAND_MIDPOINT: Record<Rag, number> = { GREEN: 95, AMBER: 65, RED: 30 };

export interface PortfolioHealth {
  score: number; // 0..100 budget-weighted aggregate
  rag: Rag;
  weightedByBudget: boolean;
}

/**
 * Single "health of the portfolio" indicator: RAG band midpoints weighted by
 * project budget (bigger budgets move the needle more). Falls back to equal
 * weighting when no project has a budget. Empty portfolio = healthy.
 */
export function portfolioHealth(
  items: readonly { rag: Rag; budgetUSD: number }[]
): PortfolioHealth {
  if (items.length === 0) return { score: 100, rag: "GREEN", weightedByBudget: false };

  const totalBudget = items.reduce(
    (acc, i) => acc + (Number.isFinite(i.budgetUSD) ? Math.max(0, i.budgetUSD) : 0),
    0
  );
  const weightedByBudget = totalBudget > 0;

  let weighted = 0;
  for (const i of items) {
    const w = weightedByBudget ? Math.max(0, i.budgetUSD) / totalBudget : 1 / items.length;
    weighted += w * BAND_MIDPOINT[i.rag];
  }

  const score = Math.round(weighted * 10) / 10;
  return { score, rag: scoreToRag(score), weightedByBudget };
}
