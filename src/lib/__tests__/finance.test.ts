import { describe, expect, it } from "vitest";
import {
  computeEva,
  computeVariance,
  formatMoneyCompact,
  localToUsd,
  sumUSD,
  usdToLocal,
} from "@/lib/finance";

describe("computeVariance", () => {
  const base = {
    localCurrency: "USD" as const,
    fxRateToBase: 1,
  };

  it("computes totals and variance in exact cents", () => {
    const r = computeVariance({
      ...base,
      capexBudgetUSD: 0.1,
      opexBudgetUSD: 0.2,
      capexActualUSD: 0.3,
      opexActualUSD: 0,
    });
    // 0.1 + 0.2 === 0.30000000000000004 in raw floats; cents math keeps it exact.
    expect(r.totalBudgetUSD).toBe(0.3);
    expect(r.varianceUSD).toBe(0);
    expect(r.overBudget).toBe(false);
  });

  it("flags >20% variance as red-threshold breach (SRS)", () => {
    const r = computeVariance({
      ...base,
      capexBudgetUSD: 100_000,
      opexBudgetUSD: 0,
      capexActualUSD: 121_000,
      opexActualUSD: 0,
    });
    expect(r.variancePct).toBeCloseTo(21);
    expect(r.breachesRedThreshold).toBe(true);
    expect(r.breachesAmberThreshold).toBe(true);
  });

  it("flags 10-20% variance as amber but not red (SRS)", () => {
    const r = computeVariance({
      ...base,
      capexBudgetUSD: 100_000,
      opexBudgetUSD: 0,
      capexActualUSD: 116_000,
      opexActualUSD: 0,
    });
    expect(r.breachesAmberThreshold).toBe(true);
    expect(r.breachesRedThreshold).toBe(false);
  });

  it("returns null variancePct for zero budget instead of dividing by zero", () => {
    const r = computeVariance({
      ...base,
      capexBudgetUSD: 0,
      opexBudgetUSD: 0,
      capexActualUSD: 5_000,
      opexActualUSD: 0,
    });
    expect(r.variancePct).toBeNull();
    expect(r.overBudget).toBe(true);
    expect(r.breachesRedThreshold).toBe(false);
  });

  it("thresholds are strictly greater-than (10% and 20% exactly do not breach)", () => {
    const at10 = computeVariance({
      ...base,
      capexBudgetUSD: 100,
      opexBudgetUSD: 0,
      capexActualUSD: 110,
      opexActualUSD: 0,
    });
    expect(at10.breachesAmberThreshold).toBe(false);
    const at20 = computeVariance({
      ...base,
      capexBudgetUSD: 100,
      opexBudgetUSD: 0,
      capexActualUSD: 120,
      opexActualUSD: 0,
    });
    expect(at20.breachesRedThreshold).toBe(false);
    expect(at20.breachesAmberThreshold).toBe(true);
  });
});

describe("computeEva", () => {
  const NOW = new Date("2026-07-01T00:00:00Z");
  const DAY = 86_400_000;
  const past = (n: number) => new Date(NOW.getTime() - n * DAY);
  const future = (n: number) => new Date(NOW.getTime() + n * DAY);

  it("computes PV/EV/AC with SPI and CPI", () => {
    const r = computeEva(
      {
        budgetAtCompletionUSD: 100_000,
        actualCostUSD: 30_000,
        milestones: [
          { targetDate: past(10), completed: true, weightPercent: 40 }, // planned & earned
          { targetDate: past(5), completed: false, weightPercent: 20 }, // planned, not earned
          { targetDate: future(30), completed: false, weightPercent: 40 },
        ],
      },
      NOW
    );
    expect(r.plannedValueUSD).toBe(60_000);
    expect(r.earnedValueUSD).toBe(40_000);
    expect(r.actualCostUSD).toBe(30_000);
    expect(r.scheduleVarianceUSD).toBe(-20_000);
    expect(r.costVarianceUSD).toBe(10_000);
    expect(r.spi).toBeCloseTo(40_000 / 60_000, 5);
    expect(r.cpi).toBeCloseTo(40_000 / 30_000, 5);
  });

  it("returns null SPI/CPI when PV or AC is zero (no division by zero)", () => {
    const r = computeEva(
      {
        budgetAtCompletionUSD: 100_000,
        actualCostUSD: 0,
        milestones: [{ targetDate: future(10), completed: false, weightPercent: 100 }],
      },
      NOW
    );
    expect(r.plannedValueUSD).toBe(0);
    expect(r.spi).toBeNull();
    expect(r.cpi).toBeNull();
  });

  it("falls back to equal weights when all weights are zero", () => {
    const r = computeEva(
      {
        budgetAtCompletionUSD: 100_000,
        actualCostUSD: 10_000,
        milestones: [
          { targetDate: past(1), completed: true, weightPercent: 0 },
          { targetDate: future(1), completed: false, weightPercent: 0 },
        ],
      },
      NOW
    );
    expect(r.plannedValueUSD).toBe(50_000);
    expect(r.earnedValueUSD).toBe(50_000);
  });

  it("handles no milestones and garbage inputs safely", () => {
    const r = computeEva(
      { budgetAtCompletionUSD: NaN, actualCostUSD: -5, milestones: [] },
      NOW
    );
    expect(r.plannedValueUSD).toBe(0);
    expect(r.earnedValueUSD).toBe(0);
    expect(r.actualCostUSD).toBe(0);
    expect(r.spi).toBeNull();
    expect(r.cpi).toBeNull();
  });
});

describe("currency conversion", () => {
  it("converts USD to XOF at the stored rate", () => {
    expect(usdToLocal(1_000, 605.5)).toBe(605_500);
  });

  it("round-trips USD -> EUR -> USD within a cent", () => {
    const eur = usdToLocal(1_234.56, 0.92);
    const back = localToUsd(eur, 0.92);
    expect(Math.abs(back - 1_234.56)).toBeLessThan(0.01);
  });

  it("throws on zero, negative, or non-finite FX rates", () => {
    expect(() => usdToLocal(100, 0)).toThrow(RangeError);
    expect(() => usdToLocal(100, -5)).toThrow(RangeError);
    expect(() => usdToLocal(100, NaN)).toThrow(RangeError);
    expect(() => localToUsd(100, 0)).toThrow(RangeError);
  });

  it("throws on non-finite amounts", () => {
    expect(() => usdToLocal(NaN, 605.5)).toThrow(RangeError);
    expect(() => usdToLocal(Infinity, 605.5)).toThrow(RangeError);
  });
});

describe("sumUSD", () => {
  it("avoids float drift", () => {
    expect(sumUSD(0.1, 0.2)).toBe(0.3);
    expect(sumUSD(1_000_000.01, 0.02, 0.03)).toBe(1_000_000.06);
  });
});

describe("formatMoneyCompact", () => {
  it("formats magnitudes", () => {
    expect(formatMoneyCompact(2_400_000)).toBe("$2.4M");
    expect(formatMoneyCompact(84_500)).toBe("$85K");
    expect(formatMoneyCompact(999)).toBe("$999");
    expect(formatMoneyCompact(-120_000)).toBe("-$120K");
  });
});
