/**
 * A fixed-window rate limiter held in process memory.
 *
 * Sufficient for a modular monolith: the open endpoints it protects (dynamic client
 * registration, CIMD fetches) are cheap to serve and only need a ceiling on abuse. If we
 * ever run more than one instance, this becomes a Postgres-backed implementation of the
 * same `RateLimiter` interface and nothing else changes.
 */

import type { Clock, RateLimiter } from './deps.js';

export interface InMemoryRateLimiterOptions {
  limit: number;
  windowSeconds: number;
  now?: Clock;
}

export function createInMemoryRateLimiter(options: InMemoryRateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => new Date());
  const windowMs = options.windowSeconds * 1000;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    async take(key: string): Promise<boolean> {
      const t = now().getTime();
      const bucket = buckets.get(key);
      if (bucket === undefined || bucket.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        // Opportunistic cleanup: this map is only as large as the number of distinct
        // callers inside one window.
        if (buckets.size > 10_000) {
          for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
        }
        return true;
      }
      if (bucket.count >= options.limit) return false;
      bucket.count += 1;
      return true;
    },
  };
}

/** A limiter that never rejects. Used where a caller has already been authenticated. */
export const unlimited: RateLimiter = { take: async () => true };
