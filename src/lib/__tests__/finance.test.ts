import { describe, expect, it } from "vitest";
import {
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

  it("flags >15% variance as red-threshold breach", () => {
    const r = computeVariance({
      ...base,
      capexBudgetUSD: 100_000,
      opexBudgetUSD: 0,
      capexActualUSD: 116_000,
      opexActualUSD: 0,
    });
    expect(r.variancePct).toBeCloseTo(16);
    expect(r.breachesRedThreshold).toBe(true);
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

  it("15% exactly does not breach (strictly greater)", () => {
    const r = computeVariance({
      ...base,
      capexBudgetUSD: 100,
      opexBudgetUSD: 0,
      capexActualUSD: 115,
      opexActualUSD: 0,
    });
    expect(r.breachesRedThreshold).toBe(false);
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
