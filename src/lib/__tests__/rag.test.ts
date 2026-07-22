import { describe, expect, it } from "vitest";
import {
  computeBlockerHealth,
  computeBudgetHealth,
  computeRag,
  computeScheduleHealth,
  effectiveRag,
  portfolioHealth,
} from "@/lib/rag";

const NOW = new Date("2026-07-01T00:00:00Z");
const DAY = 86_400_000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}
function daysAhead(n: number): Date {
  return new Date(NOW.getTime() + n * DAY);
}

describe("computeScheduleHealth", () => {
  it("is healthy with no milestones (unknown ≠ bad)", () => {
    expect(computeScheduleHealth([], NOW)).toEqual({ health: 1, maxDelayDays: 0 });
  });

  it("is healthy for on-track pending milestones", () => {
    const r = computeScheduleHealth(
      [{ targetDate: daysAhead(10), actualDate: null, status: "PENDING", weightPercent: 100 }],
      NOW
    );
    expect(r.health).toBe(1);
    expect(r.maxDelayDays).toBe(0);
  });

  it("degrades for delayed milestones and tracks max delay", () => {
    const r = computeScheduleHealth(
      [{ targetDate: daysAgo(15), actualDate: null, status: "DELAYED", weightPercent: 100 }],
      NOW
    );
    expect(r.health).toBeCloseTo(0.5, 5);
    expect(r.maxDelayDays).toBe(15);
  });

  it("uses completion date, not now, for completed milestones", () => {
    const r = computeScheduleHealth(
      [
        {
          targetDate: daysAgo(40),
          actualDate: daysAgo(40),
          status: "COMPLETED",
          weightPercent: 100,
        },
      ],
      NOW
    );
    expect(r.health).toBe(1);
  });

  it("falls back to unweighted average when all weights are zero (no division by zero)", () => {
    const r = computeScheduleHealth(
      [
        { targetDate: daysAhead(5), actualDate: null, status: "PENDING", weightPercent: 0 },
        { targetDate: daysAgo(30), actualDate: null, status: "DELAYED", weightPercent: 0 },
      ],
      NOW
    );
    expect(r.health).toBeCloseTo(0.5, 5);
  });
});

describe("computeBudgetHealth", () => {
  it("is healthy with no financials", () => {
    expect(computeBudgetHealth(null)).toEqual({ health: 1, variancePct: null });
  });

  it("handles zero budget + zero actual without division by zero", () => {
    expect(computeBudgetHealth({ totalBudgetUSD: 0, totalActualUSD: 0 })).toEqual({
      health: 1,
      variancePct: 0,
    });
  });

  it("treats spend against zero budget as fully unhealthy", () => {
    const r = computeBudgetHealth({ totalBudgetUSD: 0, totalActualUSD: 50_000 });
    expect(r.health).toBe(0);
  });

  it("is healthy under budget", () => {
    const r = computeBudgetHealth({ totalBudgetUSD: 100, totalActualUSD: 80 });
    expect(r.health).toBe(1);
    expect(r.variancePct).toBeCloseTo(-20);
  });

  it("degrades linearly over budget", () => {
    const r = computeBudgetHealth({ totalBudgetUSD: 100, totalActualUSD: 115 });
    expect(r.variancePct).toBeCloseTo(15);
    expect(r.health).toBeCloseTo(0.5, 5);
  });

  it("survives NaN/Infinity inputs", () => {
    expect(computeBudgetHealth({ totalBudgetUSD: NaN, totalActualUSD: 10 }).health).toBe(1);
    expect(
      computeBudgetHealth({ totalBudgetUSD: Infinity, totalActualUSD: 10 }).health
    ).toBe(1);
  });
});

describe("computeBlockerHealth", () => {
  it("is healthy with no open blockers", () => {
    const r = computeBlockerHealth(
      [{ severity: "CRITICAL", status: "RESOLVED", createdAt: daysAgo(30) }],
      NOW
    );
    expect(r.health).toBe(1);
  });

  it("penalizes aged critical blockers hard", () => {
    const r = computeBlockerHealth(
      [{ severity: "CRITICAL", status: "OPEN", createdAt: daysAgo(14) }],
      NOW
    );
    expect(r.health).toBe(0);
    expect(r.criticalOpenDays).toBe(14);
  });

  it("penalizes low severity lightly", () => {
    const r = computeBlockerHealth(
      [{ severity: "LOW", status: "OPEN", createdAt: daysAgo(1) }],
      NOW
    );
    expect(r.health).toBeGreaterThan(0.9);
  });
});

describe("computeRag — composite & hard rules", () => {
  it("returns GREEN for a healthy project", () => {
    const r = computeRag(
      {
        milestones: [
          { targetDate: daysAhead(30), actualDate: null, status: "PENDING", weightPercent: 100 },
        ],
        blockers: [],
        financials: { totalBudgetUSD: 100_000, totalActualUSD: 40_000 },
      },
      NOW
    );
    expect(r.rag).toBe("GREEN");
  });

  it("forces at-best AMBER when a milestone is >14 days late", () => {
    const r = computeRag(
      {
        milestones: [
          { targetDate: daysAgo(15), actualDate: null, status: "DELAYED", weightPercent: 10 },
          { targetDate: daysAhead(60), actualDate: null, status: "PENDING", weightPercent: 90 },
        ],
        blockers: [],
        financials: { totalBudgetUSD: 100_000, totalActualUSD: 10_000 },
      },
      NOW
    );
    expect(r.rag).toBe("AMBER");
    expect(r.reasons.join(" ")).toContain(">14d");
  });

  it("forces RED when a critical blocker is open >7 days", () => {
    const r = computeRag(
      {
        milestones: [
          { targetDate: daysAhead(30), actualDate: null, status: "PENDING", weightPercent: 100 },
        ],
        blockers: [{ severity: "CRITICAL", status: "OPEN", createdAt: daysAgo(8) }],
        financials: { totalBudgetUSD: 100_000, totalActualUSD: 10_000 },
      },
      NOW
    );
    expect(r.rag).toBe("RED");
  });

  it("forces RED when budget variance exceeds 20% (SRS)", () => {
    const r = computeRag(
      {
        milestones: [],
        blockers: [],
        financials: { totalBudgetUSD: 100_000, totalActualUSD: 121_000 },
      },
      NOW
    );
    expect(r.rag).toBe("RED");
  });

  it("caps at AMBER when budget variance is between 10% and 20% (SRS)", () => {
    const r = computeRag(
      {
        milestones: [],
        blockers: [],
        financials: { totalBudgetUSD: 100_000, totalActualUSD: 112_000 },
      },
      NOW
    );
    expect(r.rag).toBe("AMBER");
    expect(r.reasons.join(" ")).toContain(">10%");
  });

  it("handles empty everything (new project) as GREEN with H=100", () => {
    const r = computeRag({ milestones: [], blockers: [], financials: null }, NOW);
    expect(r.rag).toBe("GREEN");
    expect(r.score).toBe(100);
  });

  it("weights components 0.40/0.35/0.25 on the 0-100 scale", () => {
    // schedule 0, budget 1, blocker 1 → H = 60 → AMBER band boundary
    const r = computeRag(
      {
        milestones: [
          { targetDate: daysAgo(30), actualDate: null, status: "DELAYED", weightPercent: 100 },
        ],
        blockers: [],
        financials: { totalBudgetUSD: 100_000, totalActualUSD: 50_000 },
      },
      NOW
    );
    expect(r.score).toBeCloseTo(60, 5);
    expect(r.rag).toBe("AMBER");
  });
});

describe("EVA-integrated hard rules", () => {
  const healthy = {
    milestones: [
      {
        targetDate: daysAhead(30),
        actualDate: null,
        status: "PENDING" as const,
        weightPercent: 100,
      },
    ],
    blockers: [],
    financials: { totalBudgetUSD: 100_000, totalActualUSD: 40_000 },
  };

  it("caps at AMBER when CPI < 0.85", () => {
    const r = computeRag({ ...healthy, eva: { cpi: 0.8, spi: 1.1 } }, NOW);
    expect(r.rag).toBe("AMBER");
    expect(r.reasons.join(" ")).toContain("CPI");
  });

  it("caps at AMBER when SPI < 0.85", () => {
    const r = computeRag({ ...healthy, eva: { cpi: 1.0, spi: 0.7 } }, NOW);
    expect(r.rag).toBe("AMBER");
    expect(r.reasons.join(" ")).toContain("SPI");
  });

  it("stays GREEN with healthy indices, and ignores null indices", () => {
    expect(computeRag({ ...healthy, eva: { cpi: 1.05, spi: 0.95 } }, NOW).rag).toBe("GREEN");
    expect(computeRag({ ...healthy, eva: { cpi: null, spi: null } }, NOW).rag).toBe("GREEN");
  });
});

describe("risk register hard rules", () => {
  const healthy = {
    milestones: [
      {
        targetDate: daysAhead(30),
        actualDate: null,
        status: "PENDING" as const,
        weightPercent: 100,
      },
    ],
    blockers: [],
    financials: { totalBudgetUSD: 100_000, totalActualUSD: 40_000 },
  };

  it("forces RED with >=2 unmitigated high risks", () => {
    const r = computeRag(
      {
        ...healthy,
        risks: [
          { score: 16, status: "OPEN", hasMitigation: false, potentialLossUSD: 0 },
          { score: 20, status: "OPEN", hasMitigation: false, potentialLossUSD: 0 },
        ],
      },
      NOW
    );
    expect(r.rag).toBe("RED");
    expect(r.reasons.join(" ")).toContain("unmitigated high risks");
  });

  it("does not force RED when high risks have mitigation plans", () => {
    const r = computeRag(
      {
        ...healthy,
        risks: [
          { score: 16, status: "OPEN", hasMitigation: true, potentialLossUSD: 0 },
          { score: 20, status: "MITIGATING", hasMitigation: true, potentialLossUSD: 0 },
        ],
      },
      NOW
    );
    expect(r.rag).toBe("GREEN");
  });

  it("caps at AMBER when active exposure exceeds 25% of budget", () => {
    const r = computeRag(
      {
        ...healthy,
        risks: [{ score: 6, status: "OPEN", hasMitigation: true, potentialLossUSD: 30_000 }],
      },
      NOW
    );
    expect(r.rag).toBe("AMBER");
    expect(r.reasons.join(" ")).toContain("exposure");
  });

  it("ignores closed/realized risks for exposure", () => {
    const r = computeRag(
      {
        ...healthy,
        risks: [
          { score: 25, status: "CLOSED", hasMitigation: false, potentialLossUSD: 90_000 },
          { score: 25, status: "REALIZED", hasMitigation: false, potentialLossUSD: 90_000 },
        ],
      },
      NOW
    );
    expect(r.rag).toBe("GREEN");
  });
});

describe("portfolioHealth rollup", () => {
  it("weights by budget", () => {
    const h = portfolioHealth([
      { rag: "RED", budgetUSD: 9_000_000 },
      { rag: "GREEN", budgetUSD: 1_000_000 },
    ]);
    // 0.9*30 + 0.1*95 = 36.5 → RED band
    expect(h.score).toBeCloseTo(36.5, 1);
    expect(h.rag).toBe("RED");
    expect(h.weightedByBudget).toBe(true);
  });

  it("falls back to equal weighting when budgets are zero", () => {
    const h = portfolioHealth([
      { rag: "RED", budgetUSD: 0 },
      { rag: "GREEN", budgetUSD: 0 },
    ]);
    expect(h.score).toBeCloseTo(62.5, 1);
    expect(h.weightedByBudget).toBe(false);
  });

  it("empty portfolio is healthy", () => {
    expect(portfolioHealth([]).rag).toBe("GREEN");
  });
});

describe("effectiveRag", () => {
  it("prefers override when present", () => {
    expect(effectiveRag("GREEN", "RED")).toBe("RED");
    expect(effectiveRag("RED", null)).toBe("RED");
    expect(effectiveRag("AMBER", undefined)).toBe("AMBER");
  });
});
