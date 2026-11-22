/**
 * Official remote Bolesa Sandbox E2E (opt-in).
 *
 * Opt-in: BOLESA_REMOTE_SANDBOX_E2E=1 + gitignored bolesa-shop/.env.remote-sandbox
 *
 * Phase A (this file): non-mutating connection + identity verification only.
 * State-changing Shop→AWB flow runs only after /me confirms test_mode=true.
 *
 * Never reuses local .env.sandbox. Never writes to vendure-dev.
 * Never updates remote Partner DB directly.
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
    assertRemoteSandboxIdentity,
    loadRemoteSandboxCredentials,
    partnerGet,
    partnerPost,
    redactToken,
    remoteSandboxCredentialsPresent,
    type RemoteSandboxCredentials,
} from './remote-sandbox-credentials';
import { assertOfficialRemoteSandboxHost } from '../../util/safe-remote-sandbox-host';

const ENABLED = process.env.BOLESA_REMOTE_SANDBOX_E2E === '1';
const HAS_CREDS = remoteSandboxCredentialsPresent();
const RUN = ENABLED && HAS_CREDS;

describe(
    'Official remote Sandbox E2E — connection & identity (non-mutating)',
    { skip: !RUN },
    () => {
        let creds: RemoteSandboxCredentials;
        const evidence: Record<string, unknown> = {
            envIdentity: 'official-remote-sandbox',
            phase: 'connection-only',
            mutatingCalls: false,
            officialRemoteSandbox: 'PENDING',
        };

        before(() => {
            creds = loadRemoteSandboxCredentials();
            const host = assertOfficialRemoteSandboxHost(creds.apiBaseUrl, creds.allowedHosts);
            evidence.partnerHost = host.host;
            evidence.tokenShape = redactToken(creds.token);
            evidence.allowedHostsConfigured = creds.allowedHosts.split(',').map(s => s.trim());
        });

        after(() => {
            const out = path.resolve(
                __dirname,
                '../../../../../../../tmp/remote-sandbox-connection-evidence.json',
            );
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
            // eslint-disable-next-line no-console
            console.log('REMOTE_SANDBOX_CONNECTION_EVIDENCE', JSON.stringify(evidence, null, 2));
        });

        it('1) GET /me confirms test_mode=true (authoritative Sandbox identity)', async () => {
            const { status, json } = await partnerGet(creds.apiBaseUrl, creds.token, '/me');
            assert.equal(status, 200, `GET /me failed: ${JSON.stringify(json)?.slice(0, 200)}`);
            const identity = assertRemoteSandboxIdentity(json, creds.expectedAccountId);
            evidence.me = {
                httpStatus: status,
                testMode: identity.testMode,
                accountId: identity.accountId,
            };
            evidence.officialRemoteSandbox = 'IDENTITY_CONFIRMED';
        });

        it('2) GET configuration (non-mutating)', async () => {
            const { status, json } = await partnerGet(
                creds.apiBaseUrl,
                creds.token,
                '/shipments/configuration',
            );
            assert.equal(status, 200);
            evidence.configuration = {
                httpStatus: status,
                hasData: Boolean(json?.data ?? json),
            };
        });

        it('3) POST geo city search (non-mutating resolution)', async () => {
            const { status, json } = await partnerPost(creds.apiBaseUrl, creds.token, '/geo/cities/search', {
                country_code: 'EG',
                query: 'Nasr',
                limit: 5,
            });
            assert.equal(status, 200);
            const list = json?.data?.list ?? json?.data ?? [];
            const first = Array.isArray(list) ? list[0] : null;
            evidence.citySearch = {
                httpStatus: status,
                hits: Array.isArray(list) ? list.length : 0,
                hasResolutionHash: Boolean(first?.resolution_hash || first?.hash),
            };
            assert.ok(Array.isArray(list) && list.length > 0, 'expected city search hits');
        });

        it('4) refuses to proceed to AWB create until identity confirmed', async () => {
            assert.equal(evidence.officialRemoteSandbox, 'IDENTITY_CONFIRMED');
            assert.equal(evidence.mutatingCalls, false);
            evidence.nextGate =
                'Shop→AWB mutating flow requires BOLESA_REMOTE_SANDBOX_MUTATING=1 after identity PASS';
        });
    },
);

describe('Official remote Sandbox E2E — prerequisites', { skip: HAS_CREDS }, () => {
    it('documents blocker when .env.remote-sandbox is absent', () => {
        assert.equal(remoteSandboxCredentialsPresent(), false);
    });
});
