/**
 * Simple fixed-window rate limiter (in-process / per Node process).
 *
 * Suitable for: local dev and single-instance Server deployments.
 *
 * Production multi-instance limitation:
 * - Each Server process keeps its own Map — limits are NOT shared across replicas.
 * - Effective ceiling ≈ maxRequests × number_of_server_instances.
 * - Do NOT add Redis here without an explicit shared-store implementation plan
 *   (key schema, TTL, fail-open vs fail-closed, and load tests).
 *
 * Until a shared limiter exists, prefer a single Shop API instance for city search
 * or terminate rate limiting at the edge (CDN / API gateway) in addition to this guard.
 */
export interface RateLimitConfig {
    maxRequests: number;
    windowMs: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
}

interface WindowState {
    count: number;
    windowStart: number;
}

export class FixedWindowRateLimiter {
    private readonly windows = new Map<string, WindowState>();

    constructor(private readonly config: RateLimitConfig) {}

    attempt(key: string, now: number = Date.now()): RateLimitResult {
        const max = Math.max(1, this.config.maxRequests);
        const windowMs = Math.max(1, this.config.windowMs);
        const existing = this.windows.get(key);
        if (!existing || now - existing.windowStart >= windowMs) {
            this.windows.set(key, { count: 1, windowStart: now });
            return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
        }
        if (existing.count >= max) {
            const retryAfterMs = Math.max(0, windowMs - (now - existing.windowStart));
            return { allowed: false, remaining: 0, retryAfterMs };
        }
        existing.count += 1;
        return { allowed: true, remaining: max - existing.count, retryAfterMs: 0 };
    }

    /** Test helper */
    reset(): void {
        this.windows.clear();
    }
}

export const DEFAULT_CITY_SEARCH_RATE_LIMIT: RateLimitConfig = {
    maxRequests: 30,
    windowMs: 60_000,
};
