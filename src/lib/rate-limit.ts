/**
 * In-memory FIXED-window rate limiter for credential endpoints.
 * (Precisely: counts reset at window boundaries — a burst straddling the
 * boundary can see up to 2× the limit; acceptable for brute-force damping.)
 * Blocked attempts still increment the count, so hammering extends nothing
 * but also gains nothing.
 *
 * Per-instance by design (no shared store dependency): each app instance
 * enforces the window independently, which still reduces brute-force
 * throughput by orders of magnitude. Swap `hit` for a Redis-backed
 * implementation when running many horizontal replicas.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

const MAX_ENTRIES = 10_000; // memory guard against key-spraying

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function hit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): RateLimitResult {
  // Opportunistic cleanup of expired windows.
  if (windows.size > MAX_ENTRIES) {
    for (const [k, w] of windows) {
      if (w.resetAt <= now) windows.delete(k);
    }
    // Still over the cap after cleanup: fail closed for new keys.
    if (windows.size > MAX_ENTRIES && !windows.has(key)) {
      return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
    }
  }

  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  current.count += 1;
  if (current.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test hook. */
export function resetRateLimiter(): void {
  windows.clear();
}
