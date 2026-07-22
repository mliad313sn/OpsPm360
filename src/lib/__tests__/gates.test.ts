import { describe, expect, it } from "vitest";
import {
  GATE_EXIT_CHECKLISTS,
  GATE_ORDER,
  isGate,
  missingGateItems,
  nextGate,
} from "@/lib/gates";

describe("stage-gate engine", () => {
  it("orders the five SRS gates", () => {
    expect(GATE_ORDER).toEqual([
      "INTEL_GATHERING",
      "ARCH_REVIEW",
      "EXECUTION",
      "HANDOVER",
      "CLOSED",
    ]);
  });

  it("advances linearly and terminates at CLOSED", () => {
    expect(nextGate("INTEL_GATHERING")).toBe("ARCH_REVIEW");
    expect(nextGate("ARCH_REVIEW")).toBe("EXECUTION");
    expect(nextGate("EXECUTION")).toBe("HANDOVER");
    expect(nextGate("HANDOVER")).toBe("CLOSED");
    expect(nextGate("CLOSED")).toBeNull();
  });

  it("blocks advancement until every exit item is confirmed", () => {
    const missing = missingGateItems("ARCH_REVIEW", { infosecAssessment: true });
    expect(missing.map((m) => m.key)).toEqual(["vendorRiskReview", "eaAlignment"]);
  });

  it("treats false and absent answers as missing", () => {
    expect(
      missingGateItems("INTEL_GATHERING", {
        businessCaseApproved: false,
        siteReadinessConfirmed: true,
      }).map((m) => m.key)
    ).toEqual(["businessCaseApproved"]);
  });

  it("passes when all items are confirmed", () => {
    const answers = Object.fromEntries(
      GATE_EXIT_CHECKLISTS.HANDOVER.map((i) => [i.key, true])
    );
    expect(missingGateItems("HANDOVER", answers)).toEqual([]);
  });

  it("validates gate names", () => {
    expect(isGate("EXECUTION")).toBe(true);
    expect(isGate("NOT_A_GATE")).toBe(false);
  });
});
