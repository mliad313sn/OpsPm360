/** PMBOK-style risk scoring: probability (1-5) × impact (1-5) → 1..25. */

export function riskScore(probability: number, impact: number): number {
  const p = Math.min(5, Math.max(1, Math.trunc(probability)));
  const i = Math.min(5, Math.max(1, Math.trunc(impact)));
  return p * i;
}

export type RiskBand = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export function riskBand(score: number): RiskBand {
  if (score >= 20) return "CRITICAL";
  if (score >= 12) return "HIGH";
  if (score >= 6) return "MEDIUM";
  return "LOW";
}
