import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixedWindowRateLimiter } from '../util/rate-limit';

describe('FixedWindowRateLimiter', () => {
    it('allows up to maxRequests within the window', () => {
        const limiter = new FixedWindowRateLimiter({ maxRequests: 3, windowMs: 60_000 });
        const t0 = 1_000_000;
        assert.equal(limiter.attempt('k', t0).allowed, true);
        assert.equal(limiter.attempt('k', t0 + 1).allowed, true);
        assert.equal(limiter.attempt('k', t0 + 2).allowed, true);
        const blocked = limiter.attempt('k', t0 + 3);
        assert.equal(blocked.allowed, false);
        assert.ok(blocked.retryAfterMs > 0);
    });

    it('resets after the window elapses', () => {
        const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 100 });
        const t0 = 1_000_000;
        assert.equal(limiter.attempt('k', t0).allowed, true);
        assert.equal(limiter.attempt('k', t0 + 50).allowed, false);
        assert.equal(limiter.attempt('k', t0 + 100).allowed, true);
    });

    it('isolates keys (channel/session)', () => {
        const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 });
        const t0 = 1_000_000;
        assert.equal(limiter.attempt('a', t0).allowed, true);
        assert.equal(limiter.attempt('b', t0).allowed, true);
        assert.equal(limiter.attempt('a', t0 + 1).allowed, false);
    });
});
