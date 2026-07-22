/**
 * Dual-currency CapEx/OpEx financial engine.
 *
 * All amounts are stored in USD (base currency) with 2-decimal precision.
 * Local-currency display uses fxRateToBase = units of local currency per 1 USD.
 * Arithmetic is done in integer cents to avoid IEEE-754 drift on ledger math.
 */

export type LocalCurrency = "USD" | "EUR" | "XOF";

export interface FinancialSnapshot {
  capexBudgetUSD: number;
  opexBudgetUSD: number;
  capexActualUSD: number;
  opexActualUSD: number;
  localCurrency: LocalCurrency;
  fxRateToBase: number;
}

export interface VarianceReport {
  totalBudgetUSD: number;
  totalActualUSD: number;
  varianceUSD: number; // actual - budget (positive = over budget)
  variancePct: number | null; // null when budget is zero (undefined ratio)
  capexVarianceUSD: number;
  opexVarianceUSD: number;
  overBudget: boolean;
  breachesRedThreshold: boolean; // > +15%
}

const RED_VARIANCE_THRESHOLD_PCT = 15;

function toCents(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(usd * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

/** Round-trip-safe USD addition via integer cents. */
export function sumUSD(...amounts: number[]): number {
  return fromCents(amounts.reduce((acc, a) => acc + toCents(a), 0));
}

export function computeVariance(fin: FinancialSnapshot): VarianceReport {
  const budgetCents = toCents(fin.capexBudgetUSD) + toCents(fin.opexBudgetUSD);
  const actualCents = toCents(fin.capexActualUSD) + toCents(fin.opexActualUSD);
  const varianceCents = actualCents - budgetCents;

  const variancePct = budgetCents === 0 ? null : (varianceCents / budgetCents) * 100;

  return {
    totalBudgetUSD: fromCents(budgetCents),
    totalActualUSD: fromCents(actualCents),
    varianceUSD: fromCents(varianceCents),
    variancePct,
    capexVarianceUSD: fromCents(toCents(fin.capexActualUSD) - toCents(fin.capexBudgetUSD)),
    opexVarianceUSD: fromCents(toCents(fin.opexActualUSD) - toCents(fin.opexBudgetUSD)),
    overBudget: varianceCents > 0,
    breachesRedThreshold: variancePct !== null && variancePct > RED_VARIANCE_THRESHOLD_PCT,
  };
}

/**
 * Convert a USD amount to the project's local currency.
 * Throws on non-positive FX rates — a zero/negative rate is data corruption,
 * not a display concern.
 */
export function usdToLocal(amountUSD: number, fxRateToBase: number): number {
  if (!Number.isFinite(fxRateToBase) || fxRateToBase <= 0) {
    throw new RangeError(`Invalid FX rate: ${fxRateToBase}. Must be a positive number.`);
  }
  if (!Number.isFinite(amountUSD)) {
    throw new RangeError(`Invalid USD amount: ${amountUSD}`);
  }
  // XOF has no minor unit; round to whole francs. EUR/USD keep cents.
  const raw = amountUSD * fxRateToBase;
  return Math.round(raw * 100) / 100;
}

export function localToUsd(amountLocal: number, fxRateToBase: number): number {
  if (!Number.isFinite(fxRateToBase) || fxRateToBase <= 0) {
    throw new RangeError(`Invalid FX rate: ${fxRateToBase}. Must be a positive number.`);
  }
  if (!Number.isFinite(amountLocal)) {
    throw new RangeError(`Invalid local amount: ${amountLocal}`);
  }
  return fromCents(toCents(amountLocal / fxRateToBase));
}

const CURRENCY_LOCALE: Record<LocalCurrency, { locale: string; minimumFractionDigits: number }> = {
  USD: { locale: "en-US", minimumFractionDigits: 0 },
  EUR: { locale: "de-DE", minimumFractionDigits: 0 },
  XOF: { locale: "fr-FR", minimumFractionDigits: 0 },
};

export function formatMoney(amount: number, currency: LocalCurrency = "USD"): string {
  const cfg = CURRENCY_LOCALE[currency];
  return new Intl.NumberFormat(cfg.locale, {
    style: "currency",
    currency,
    minimumFractionDigits: cfg.minimumFractionDigits,
    maximumFractionDigits: cfg.minimumFractionDigits,
  }).format(amount);
}

/** Compact display for dashboards: $1.2M, $840K. */
export function formatMoneyCompact(amountUSD: number): string {
  const abs = Math.abs(amountUSD);
  const sign = amountUSD < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
