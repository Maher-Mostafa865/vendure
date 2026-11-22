/**
 * Phase 0 spike (isolated): does route-scoped express.raw({type:'application/json'})
 * with beforeListen-style ordering leave req.body as a Buffer for HMAC verification?
 *
 * Mirrors Vendure bootstrap order from packages/core/src/bootstrap.ts:
 *   1. NestFactory.create(...)  [here: plain Express app + express.json()]
 *   2. mount beforeListen middleware with app.use(route, handler)
 *   3. app.listen()
 *
 * Also mirrors wrap-early-middleware-handler.ts: route-scoped parsers run first
 * on their route without suppressing the global parser.
 *
 * Run: node phase0/spikes/raw-body-middleware.spike.mjs
 */
import express from 'express';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

const SECRET = 'phase0-webhook-secret';
const PATH = '/bolesa/webhooks/conn-1';
const payload = JSON.stringify({
    id: 'evt_phase0',
    type: 'awb.status_updated',
    api_version: 'v1',
    created_at: new Date().toISOString(),
    data: { tracking_number: 'PHASE0-FAKE' },
});
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac('sha256', SECRET)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
const header = `t=${timestamp},v1=${signature}`;

function wrapRouteParser(handler) {
    // Same idea as wrapEarlyMiddlewareHandler: avoid Nest name collision by wrapping.
    return function scopedHandler(req, res, next) {
        return handler(req, res, next);
    };
}

async function run() {
    const app = express();

    // Simulate Nest's global JSON parser (mounted after create, before listen extras).
    // In Vendure, beforeListen middleware is mounted AFTER NestFactory.create but BEFORE
    // listen; Nest also registers its own body parser. We mount global json first, then
    // route-scoped raw, to stress the harder case.
    app.use(express.json({ limit: '1mb' }));

    // beforeListen-style route middleware
    app.use(
        PATH,
        wrapRouteParser(
            express.raw({
                type: 'application/json',
                limit: '1mb',
            }),
        ),
    );

    let observed = null;
    app.post(PATH, (req, res) => {
        observed = {
            isBuffer: Buffer.isBuffer(req.body),
            typeofBody: typeof req.body,
            bodyEqualsPayload: Buffer.isBuffer(req.body)
                ? req.body.toString('utf8') === payload
                : false,
            parsedObjectKeys: req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
                ? Object.keys(req.body)
                : null,
        };

        const raw = Buffer.isBuffer(req.body)
            ? req.body.toString('utf8')
            : typeof req.body === 'string'
              ? req.body
              : JSON.stringify(req.body);
        const expected = createHmac('sha256', SECRET).update(`${timestamp}.${raw}`).digest('hex');
        observed.hmacOk = expected === signature;
        res.status(200).json({ ok: true });
    });

    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    const res = await fetch(`http://127.0.0.1:${port}${PATH}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'XP-Signature': header,
            'XP-Event': 'awb.status_updated',
            'XP-Event-Id': 'evt_phase0',
            'XP-Timestamp': String(timestamp),
        },
        body: payload,
    });
    assert.equal(res.status, 200);
    server.close();

    // When global json() runs first, route-scoped raw() often sees an already-parsed body
    // and does nothing. That is the failure mode we need to detect.
    console.log(
        JSON.stringify(
            {
                ok: true,
                observed,
                conclusion: observed?.isBuffer
                    ? 'PASS: raw body available as Buffer; HMAC verification works with beforeListen-style route middleware AFTER a global json parser in this Express setup.'
                    : 'FAIL under Nest-like ordering: global express.json() consumed the body before route-scoped express.raw(). Prefer bootstrap nestApplicationOptions.rawBody=true OR mount raw middleware on a catch-all beforeListen route so Nest does not register a conflicting parser. Do not rely on route-scoped express.raw alone.',
                vendureRefs: [
                    'packages/core/src/bootstrap.ts:240-252',
                    'packages/core/src/wrap-early-middleware-handler.ts',
                    'packages/core/src/common/types/common-types.ts Middleware.beforeListen',
                ],
            },
            null,
            2,
        ),
    );

    if (!observed?.isBuffer) {
        process.exitCode = 2;
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
