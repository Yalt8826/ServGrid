/**
 * A small in-process sliding-window rate limiter, used for login's
 * 5/min per username + IP (PLAN-BACKEND.md §4).
 *
 * Per-process is deliberate today: the API runs as a single replica, and
 * the moment that stops being true this must move to shared state
 * (Postgres or Redis) — otherwise the limit silently becomes
 * per-instance and N instances mean N times the guessing budget. The
 * single call site imports this file, so there is exactly one place to
 * change.
 */

export interface SlidingWindowLimiter {
  /** Record one hit for `key`; false when the key is over its limit. */
  take(key: string): boolean;
}

export interface SlidingWindowOptions {
  /** Hits allowed per window; hit `limit + 1` is refused. */
  limit: number;
  windowMs: number;
  /**
   * Bound on tracked keys before a sweep prunes expired entries. Usernames
   * × IPs grows without limit on the public internet; login calls `take`
   * on every attempt, so the sweep keeps the map from outliving its data.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export function createSlidingWindowLimiter(options: SlidingWindowOptions): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;

  return {
    take(key: string): boolean {
      const now = Date.now();
      if (hits.size > maxKeys) {
        for (const [k, timestamps] of hits) {
          const alive = timestamps.filter((t) => now - t < options.windowMs);
          if (alive.length === 0) hits.delete(k);
          else hits.set(k, alive);
        }
      }
      const recent = (hits.get(key) ?? []).filter((t) => now - t < options.windowMs);
      recent.push(now);
      hits.set(key, recent);
      return recent.length <= options.limit;
    },
  };
}
