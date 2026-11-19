/**
 * Phase 0 spike variant: mount route-scoped express.raw BEFORE the global
 * express.json(), matching Vendure's beforeListen mount (bootstrap.ts mounts
 * beforeListen middleware after NestFactory.create but Nest's body parser is
 * registered as part of the Nest HTTP adapter lifecycle).
 *
 * This variant answers: if raw is first on the webhook route, does HMAC work?
 *
 * Run: node phase0/spikes/raw-body-beforelisten.spike.mjs
 */
import express from 'express';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

const SECRET = 'phase0-webhook-secret';
const PATH = '/bolesa/webhooks/conn-1';
const payload = JSON.stringify({ id: 'evt_phase0', type: 'awb.status_updated', data: {} });
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac('sha256', SECRET).update(`${timestamp}.${payload}`).digest('hex');

async function run() {
    const app = express();

    // beforeListen first on the webhook route
    app.use(
        PATH,
        function scopedRaw(req, res, next) {
            return express.raw({ type: 'application/json', limit: '1mb' })(req, res, next);
        },
    );

    // Then global JSON (other routes)
    app.use(express.json({ limit: '1mb' }));

    let observed = null;
    app.post(PATH, (req, res) => {
        const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null;
        observed = {
            isBuffer: Buffer.isBuffer(req.body),
            bodyEqualsPayload: raw === payload,
            hmacOk:
                raw != null &&
                createHmac('sha256', SECRET).update(`${timestamp}.${raw}`).digest('hex') === signature,
        };
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
            'XP-Signature': `t=${timestamp},v1=${signature}`,
        },
        body: payload,
    });
    assert.equal(res.status, 200);
    server.close();

    console.log(
        JSON.stringify(
            {
                ok: true,
                observed,
                conclusion: observed?.isBuffer && observed?.hmacOk
                    ? 'PASS: when express.raw is mounted on the webhook route BEFORE global express.json, req.body is a Buffer and HMAC verifies.'
                    : 'FAIL: raw-before-json ordering did not yield a Buffer body.',
            },
            null,
            2,
        ),
    );
    if (!(observed?.isBuffer && observed?.hmacOk)) {
        process.exitCode = 2;
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
