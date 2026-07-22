import "server-only";

import { headers } from "next/headers";

/**
 * Best-effort client IP for the COBIT audit trail (SRS Module 1).
 * Reads proxy-forwarded headers; returns null when unavailable rather than
 * guessing. Only meaningful behind a trusted proxy/load balancer.
 */
export function getClientIp(): string | null {
  try {
    const h = headers();
    const forwarded = h.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
    return h.get("x-real-ip");
  } catch {
    // headers() throws outside a request scope (e.g. build-time evaluation).
    return null;
  }
}
