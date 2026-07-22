/**
 * COBIT 2019 Stage-Gate Engine.
 *
 * A project cannot advance to the next gate until every exit-checklist item
 * for its CURRENT gate is confirmed. Checklist snapshots are persisted on the
 * project and every advancement is audit-logged.
 */

export const GATE_ORDER = [
  "INTEL_GATHERING",
  "ARCH_REVIEW",
  "EXECUTION",
  "HANDOVER",
  "CLOSED",
] as const;

export type Gate = (typeof GATE_ORDER)[number];

export interface GateChecklistItem {
  key: string;
  label: string;
}

/** Items required to EXIT each gate (SRS Module 2). CLOSED is terminal. */
export const GATE_EXIT_CHECKLISTS: Record<Gate, GateChecklistItem[]> = {
  INTEL_GATHERING: [
    { key: "businessCaseApproved", label: "Business case approved" },
    { key: "siteReadinessConfirmed", label: "Site readiness confirmed" },
  ],
  ARCH_REVIEW: [
    { key: "infosecAssessment", label: "InfoSec assessment completed" },
    { key: "vendorRiskReview", label: "Vendor risk review completed" },
    { key: "eaAlignment", label: "Enterprise architecture alignment confirmed" },
  ],
  EXECUTION: [
    { key: "milestonesTracked", label: "Milestone tracking up to date" },
    { key: "weeklyRagReporting", label: "Weekly RAG reporting in place" },
  ],
  HANDOVER: [
    { key: "siteOpsTraining", label: "Site operations training delivered" },
    { key: "slaDocumentation", label: "SLA documentation handed over" },
    { key: "assetTagging", label: "Assets tagged and registered" },
  ],
  CLOSED: [],
};

export function isGate(value: string): value is Gate {
  return (GATE_ORDER as readonly string[]).includes(value);
}

/** The gate after `gate`, or null when the project is already CLOSED. */
export function nextGate(gate: Gate): Gate | null {
  const idx = GATE_ORDER.indexOf(gate);
  if (idx < 0 || idx === GATE_ORDER.length - 1) return null;
  return GATE_ORDER[idx + 1] ?? null;
}

/** Checklist items for the current gate that are not confirmed true. */
export function missingGateItems(
  gate: Gate,
  answers: Readonly<Record<string, boolean>>
): GateChecklistItem[] {
  return GATE_EXIT_CHECKLISTS[gate].filter((item) => answers[item.key] !== true);
}
