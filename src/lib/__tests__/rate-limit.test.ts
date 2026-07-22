import { beforeEach, describe, expect, it } from "vitest";
import { hit, resetRateLimiter } from "@/lib/rate-limit";

describe("rate limiter", () => {
  beforeEach(() => resetRateLimiter());

  it("allows up to the limit, then blocks", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(hit("k", 5, 60_000, t0 + i).allowed).toBe(true);
    }
    const blocked = hit("k", 5, 60_000, t0 + 10);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window expires", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) hit("k", 5, 60_000, t0);
    expect(hit("k", 5, 60_000, t0 + 60_001).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) hit("a", 5, 60_000, t0);
    expect(hit("a", 5, 60_000, t0).allowed).toBe(false);
    expect(hit("b", 5, 60_000, t0).allowed).toBe(true);
  });
});
