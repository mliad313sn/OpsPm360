import { describe, expect, it } from "vitest";
import {
  evaluateBlockerSla,
  runSlaSweep,
  targetLevelForAge,
  SLA_CIO_HOURS,
  SLA_GROUP_MANAGER_HOURS,
} from "@/lib/sla";

const NOW = new Date("2026-07-01T12:00:00Z");

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

describe("targetLevelForAge", () => {
  it("maps the ladder boundaries", () => {
    expect(targetLevelForAge(0)).toBe("SITE_IT_LEAD");
    expect(targetLevelForAge(SLA_GROUP_MANAGER_HOURS - 0.01)).toBe("SITE_IT_LEAD");
    expect(targetLevelForAge(SLA_GROUP_MANAGER_HOURS)).toBe("GROUP_IT_MANAGER");
    expect(targetLevelForAge(SLA_CIO_HOURS - 0.01)).toBe("GROUP_IT_MANAGER");
    expect(targetLevelForAge(SLA_CIO_HOURS)).toBe("GROUP_CIO");
    expect(targetLevelForAge(10_000)).toBe("GROUP_CIO");
  });

  it("treats invalid ages as no escalation", () => {
    expect(targetLevelForAge(NaN)).toBe("SITE_IT_LEAD");
    expect(targetLevelForAge(-5)).toBe("SITE_IT_LEAD");
  });
});

describe("evaluateBlockerSla", () => {
  it("skips resolved blockers", () => {
    expect(
      evaluateBlockerSla(
        { id: "b1", status: "RESOLVED", escalationLevel: "SITE_IT_LEAD", createdAt: hoursAgo(500) },
        NOW
      )
    ).toBeNull();
  });

  it("escalates a 49h-old blocker to Group IT Manager", () => {
    const d = evaluateBlockerSla(
      { id: "b1", status: "OPEN", escalationLevel: "SITE_IT_LEAD", createdAt: hoursAgo(49) },
      NOW
    );
    expect(d?.to).toBe("GROUP_IT_MANAGER");
    expect(d?.from).toBe("SITE_IT_LEAD");
  });

  it("escalates a 121h-old blocker straight to CIO even from SITE level", () => {
    const d = evaluateBlockerSla(
      { id: "b1", status: "OPEN", escalationLevel: "SITE_IT_LEAD", createdAt: hoursAgo(121) },
      NOW
    );
    expect(d?.to).toBe("GROUP_CIO");
  });

  it("is idempotent: already-escalated blockers do not re-escalate", () => {
    expect(
      evaluateBlockerSla(
        {
          id: "b1",
          status: "ESCALATED",
          escalationLevel: "GROUP_IT_MANAGER",
          createdAt: hoursAgo(60),
        },
        NOW
      )
    ).toBeNull();
    expect(
      evaluateBlockerSla(
        { id: "b1", status: "ESCALATED", escalationLevel: "GROUP_CIO", createdAt: hoursAgo(999) },
        NOW
      )
    ).toBeNull();
  });

  it("never de-escalates", () => {
    expect(
      evaluateBlockerSla(
        { id: "b1", status: "OPEN", escalationLevel: "GROUP_CIO", createdAt: hoursAgo(1) },
        NOW
      )
    ).toBeNull();
  });

  it("ignores future-dated blockers (offline clock skew)", () => {
    expect(
      evaluateBlockerSla(
        { id: "b1", status: "OPEN", escalationLevel: "SITE_IT_LEAD", createdAt: hoursAgo(-3) },
        NOW
      )
    ).toBeNull();
  });
});

describe("runSlaSweep", () => {
  it("returns only actionable decisions", () => {
    const decisions = runSlaSweep(
      [
        { id: "fresh", status: "OPEN", escalationLevel: "SITE_IT_LEAD", createdAt: hoursAgo(2) },
        { id: "aging", status: "OPEN", escalationLevel: "SITE_IT_LEAD", createdAt: hoursAgo(50) },
        { id: "old", status: "ESCALATED", escalationLevel: "GROUP_IT_MANAGER", createdAt: hoursAgo(130) },
        { id: "done", status: "RESOLVED", escalationLevel: "SITE_IT_LEAD", createdAt: hoursAgo(500) },
      ],
      NOW
    );
    expect(decisions.map((d) => [d.blockerId, d.to])).toEqual([
      ["aging", "GROUP_IT_MANAGER"],
      ["old", "GROUP_CIO"],
    ]);
  });

  it("re-running the sweep after applying decisions yields nothing (idempotent)", () => {
    const first = runSlaSweep(
      [{ id: "b", status: "OPEN", escalationLevel: "SITE_IT_LEAD", createdAt: hoursAgo(50) }],
      NOW
    );
    expect(first).toHaveLength(1);
    const target = first[0];
    expect(target).toBeDefined();
    const second = runSlaSweep(
      [{ id: "b", status: "ESCALATED", escalationLevel: target?.to ?? "GROUP_IT_MANAGER", createdAt: hoursAgo(50) }],
      NOW
    );
    expect(second).toHaveLength(0);
  });
});
