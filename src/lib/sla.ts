/**
 * Blocker SLA escalation engine.
 *
 * Escalation ladder (measured from blocker creation, or last escalation):
 *  - SITE_IT_LEAD  --(unresolved 48h)-->  GROUP_IT_MANAGER
 *  - GROUP_IT_MANAGER --(unresolved 120h total)--> GROUP_CIO
 *
 * The sweep is idempotent: given the same inputs it produces the same target
 * level, so replayed cron ticks never double-escalate.
 */

export type EscalationLevel = "SITE_IT_LEAD" | "GROUP_IT_MANAGER" | "GROUP_CIO";

export interface SlaBlockerInput {
  id: string;
  status: "OPEN" | "ESCALATED" | "RESOLVED";
  escalationLevel: EscalationLevel;
  createdAt: Date;
}

export interface EscalationDecision {
  blockerId: string;
  from: EscalationLevel;
  to: EscalationLevel;
  ageHours: number;
  reason: string;
}

export const SLA_GROUP_MANAGER_HOURS = 48;
export const SLA_CIO_HOURS = 120;

const LEVEL_ORDER: Record<EscalationLevel, number> = {
  SITE_IT_LEAD: 0,
  GROUP_IT_MANAGER: 1,
  GROUP_CIO: 2,
};

/** The level a blocker of this age should be at, regardless of current level. */
export function targetLevelForAge(ageHours: number): EscalationLevel {
  if (!Number.isFinite(ageHours) || ageHours < 0) return "SITE_IT_LEAD";
  if (ageHours >= SLA_CIO_HOURS) return "GROUP_CIO";
  if (ageHours >= SLA_GROUP_MANAGER_HOURS) return "GROUP_IT_MANAGER";
  return "SITE_IT_LEAD";
}

/**
 * Evaluate one blocker. Returns a decision only when escalation is required;
 * resolved blockers and already-at-level blockers return null.
 */
export function evaluateBlockerSla(
  blocker: SlaBlockerInput,
  now: Date
): EscalationDecision | null {
  if (blocker.status === "RESOLVED") return null;

  const ageHours = (now.getTime() - blocker.createdAt.getTime()) / 3_600_000;
  if (ageHours < 0) return null; // clock skew from offline clients — never "pre-escalate"

  const target = targetLevelForAge(ageHours);
  if (LEVEL_ORDER[target] <= LEVEL_ORDER[blocker.escalationLevel]) return null;

  return {
    blockerId: blocker.id,
    from: blocker.escalationLevel,
    to: target,
    ageHours,
    reason:
      target === "GROUP_CIO"
        ? `Unresolved for ${Math.floor(ageHours)}h (SLA: ${SLA_CIO_HOURS}h) — escalating to Group CIO`
        : `Unresolved for ${Math.floor(ageHours)}h (SLA: ${SLA_GROUP_MANAGER_HOURS}h) — escalating to Group IT Manager`,
  };
}

/** Run the sweep over a set of blockers. Pure; the caller persists results. */
export function runSlaSweep(
  blockers: readonly SlaBlockerInput[],
  now: Date = new Date()
): EscalationDecision[] {
  const decisions: EscalationDecision[] = [];
  for (const b of blockers) {
    const d = evaluateBlockerSla(b, now);
    if (d) decisions.push(d);
  }
  return decisions;
}
