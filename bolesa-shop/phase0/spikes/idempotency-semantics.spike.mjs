/**
 * Phase 0 spike: reproduce PartnerIdempotency semantics in isolation.
 * Source of truth: bolesa-egy/app/Modules/PartnerApi/Http/Middleware/PartnerIdempotency.php
 *
 * Verifies:
 * - empty key → pass-through
 * - invalid key → 422 invalid_idempotency_key
 * - same key + same body → replay with Idempotent-Replayed
 * - same key + different body → 422 idempotency_key_reused
 * - concurrent lock held → 409 idempotency_in_progress
 * - status < 500 cached (including 422)
 * - status >= 500 NOT cached (retryable)
 *
 * Run: node phase0/spikes/idempotency-semantics.spike.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const TTL = 86400;
const store = new Map();
const locks = new Map();

function hash(s) {
    return createHash('sha256').update(s).digest('hex');
}

function handle({ key, method, path, body, handler, accountId = 1, routeName = 'partner-api.v1.awbs.store' }) {
    if (!key) {
        return handler();
    }
    if (!/^[A-Za-z0-9_\-:.]{8,128}$/.test(key)) {
        return { status: 422, code: 'invalid_idempotency_key' };
    }
    const scope = 'partner_api:idempotency:' + hash(`${accountId}|${routeName}|${key}`);
    const fingerprint = hash(`${method}|${path}|${body}`);
    const stored = store.get(scope);
    if (stored) {
        if (stored.fingerprint !== fingerprint) {
            return { status: 422, code: 'idempotency_key_reused' };
        }
        return { status: stored.status, body: stored.body, headers: { 'Idempotent-Replayed': 'true' } };
    }
    if (locks.get(scope)) {
        return { status: 409, code: 'idempotency_in_progress' };
    }
    locks.set(scope, true);
    try {
        const response = handler();
        if (response.status < 500) {
            store.set(scope, {
                fingerprint,
                status: response.status,
                body: response.body,
                expiresIn: TTL,
            });
        }
        return response;
    } finally {
        locks.delete(scope);
    }
}

const results = [];

// 1. invalid key
{
    const r = handle({
        key: 'short',
        method: 'POST',
        path: '/awbs',
        body: '{}',
        handler: () => ({ status: 201, body: { ok: true } }),
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'invalid_idempotency_key');
    results.push({ case: 'invalid_key', pass: true });
}

// 2. replay same body
{
    let calls = 0;
    const opts = {
        key: 'order-12345',
        method: 'POST',
        path: '/awbs',
        body: '{"a":1}',
        handler: () => {
            calls++;
            return { status: 201, body: { call: calls } };
        },
    };
    const first = handle(opts);
    const second = handle(opts);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.headers?.['Idempotent-Replayed'], 'true');
    assert.equal(second.body.call, 1);
    assert.equal(calls, 1);
    results.push({ case: 'replay_same_body', pass: true });
}

// 3. different body same key
{
    const r = handle({
        key: 'order-12345',
        method: 'POST',
        path: '/awbs',
        body: '{"a":2}',
        handler: () => ({ status: 201, body: { call: 99 } }),
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'idempotency_key_reused');
    results.push({ case: 'different_body', pass: true });
}

// 4. 422 is cached (definite failure)
{
    let calls = 0;
    const opts = {
        key: 'fail-422-aaaa',
        method: 'POST',
        path: '/awbs',
        body: '{"x":1}',
        handler: () => {
            calls++;
            return { status: 422, body: { code: 'carrier_rejected' } };
        },
    };
    const a = handle(opts);
    const b = handle(opts);
    assert.equal(a.status, 422);
    assert.equal(b.status, 422);
    assert.equal(b.headers?.['Idempotent-Replayed'], 'true');
    assert.equal(calls, 1);
    results.push({ case: 'cache_422', pass: true, implication: 'manual retry must use a new Idempotency-Key after a definite 4xx' });
}

// 5. 5xx is NOT cached
{
    let calls = 0;
    const opts = {
        key: 'fail-500-bbbb',
        method: 'POST',
        path: '/awbs',
        body: '{"x":1}',
        handler: () => {
            calls++;
            return calls === 1
                ? { status: 503, body: { code: 'upstream' } }
                : { status: 201, body: { tracking_number: 'T1' } };
        },
    };
    const a = handle(opts);
    const b = handle(opts);
    assert.equal(a.status, 503);
    assert.equal(b.status, 201);
    assert.equal(calls, 2);
    results.push({ case: 'retry_5xx_same_key', pass: true });
}

// 6. concurrent lock → 409
{
    const key = 'concurrent-cccc';
    const scope =
        'partner_api:idempotency:' +
        hash(`1|partner-api.v1.awbs.store|${key}`);
    locks.set(scope, true);
    const r = handle({
        key,
        method: 'POST',
        path: '/awbs',
        body: '{}',
        handler: () => ({ status: 201, body: {} }),
    });
    assert.equal(r.status, 409);
    assert.equal(r.code, 'idempotency_in_progress');
    locks.delete(scope);
    results.push({ case: 'concurrent_409', pass: true });
}

console.log(
    JSON.stringify(
        {
            ok: true,
            results,
            source: 'app/Modules/PartnerApi/Http/Middleware/PartnerIdempotency.php',
            pestCoverage: 'tests/Feature/PartnerApi/PartnerWriteEndpointsTest.php (replay + key_reused)',
            pestRuntime: 'NOT RUN this session — Postgres 127.0.0.1:5432 down and Docker unavailable',
        },
        null,
        2,
    ),
);
