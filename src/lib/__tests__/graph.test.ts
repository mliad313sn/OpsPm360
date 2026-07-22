import { describe, expect, it } from "vitest";
import { downstreamOf, wouldCreateCycle, type Edge } from "@/lib/graph";

const chain: Edge[] = [
  { from: "A", to: "B" },
  { from: "B", to: "C" },
];

describe("wouldCreateCycle", () => {
  it("rejects self-dependency", () => {
    expect(wouldCreateCycle([], { from: "A", to: "A" })).toBe(true);
  });

  it("allows extending a chain", () => {
    expect(wouldCreateCycle(chain, { from: "C", to: "D" })).toBe(false);
  });

  it("rejects a direct back-edge", () => {
    expect(wouldCreateCycle(chain, { from: "B", to: "A" })).toBe(true);
  });

  it("rejects a transitive cycle (A→B→C, adding C→A)", () => {
    expect(wouldCreateCycle(chain, { from: "C", to: "A" })).toBe(true);
  });

  it("allows diamonds (A→B, A→C, B→D, C→D)", () => {
    const diamond: Edge[] = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
    ];
    expect(wouldCreateCycle(diamond, { from: "C", to: "D" })).toBe(false);
  });

  it("catches the two-site split-brain cycle (A→B added on site 1, B→A on site 2)", () => {
    expect(wouldCreateCycle([{ from: "A", to: "B" }], { from: "B", to: "A" })).toBe(true);
  });
});

describe("downstreamOf", () => {
  it("returns transitive successors", () => {
    expect(downstreamOf(chain, "A").sort()).toEqual(["B", "C"]);
    expect(downstreamOf(chain, "C")).toEqual([]);
  });

  it("handles branches without duplicates", () => {
    const g: Edge[] = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "C", to: "D" },
    ];
    expect(downstreamOf(g, "A").sort()).toEqual(["B", "C", "D"]);
  });
});
