/**
 * Load official remote Bolesa Sandbox credentials from gitignored `.env.remote-sandbox`.
 * Never reuse local `.env.sandbox` / 127.0.0.1 credentials.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';

import { assertOfficialRemoteSandboxHost } from '../../util/safe-remote-sandbox-host';
import { assertSafePartnerHost } from '../../util/safe-partner-host';

export type RemoteSandboxCredentials = {
    apiBaseUrl: string;
    token: string;
    allowedHosts: string;
    expectedAccountId?: string;
    envIdentity: string;
    credentialsPath: string;
};

const REMOTE_ENV_PATH = path.resolve(
    __dirname,
    '../../../../../../../.env.remote-sandbox',
);

export function remoteSandboxCredentialsPath(): string {
    return REMOTE_ENV_PATH;
}

export function remoteSandboxCredentialsPresent(): boolean {
    return fs.existsSync(REMOTE_ENV_PATH);
}

export function loadRemoteSandboxCredentials(): RemoteSandboxCredentials {
    if (!fs.existsSync(REMOTE_ENV_PATH)) {
        throw new Error(
            `SAFETY ABORT: missing ${REMOTE_ENV_PATH} — official remote Sandbox credentials not configured`,
        );
    }
    const parsed = loadDotenv({ path: REMOTE_ENV_PATH }).parsed ?? {};
    const apiBaseUrl = String(parsed.BOLESA_API_BASE_URL || '').trim().replace(/\/$/, '');
    const token = String(parsed.BOLESA_PARTNER_TOKEN || '').trim();
    const allowedHosts = String(parsed.BOLESA_REMOTE_SANDBOX_ALLOWED_HOSTS || '').trim();
    const envIdentity = String(parsed.BOLESA_ENV_IDENTITY || '').trim();
    const expectedAccountId = String(parsed.BOLESA_EXPECTED_ACCOUNT_ID || '').trim() || undefined;

    // Must not be the local Partner gate target
    let pointsAtLocalHost = false;
    try {
        assertSafePartnerHost(apiBaseUrl);
        pointsAtLocalHost = true;
    } catch {
        pointsAtLocalHost = false;
    }
    if (pointsAtLocalHost) {
        throw new Error(
            'SAFETY ABORT: .env.remote-sandbox points at a local Partner host — refuse to treat it as official remote Sandbox',
        );
    }

    assertOfficialRemoteSandboxHost(apiBaseUrl, allowedHosts);
    if (!token.startsWith('xp_')) {
        throw new Error('SAFETY ABORT: remote BOLESA_PARTNER_TOKEN missing or unexpected shape');
    }
    if (envIdentity !== 'official-remote-sandbox') {
        throw new Error(
            `SAFETY ABORT: BOLESA_ENV_IDENTITY must be "official-remote-sandbox" (got ${envIdentity || 'empty'})`,
        );
    }

    // Ensure allowlist is also visible to process for later asserts
    process.env.BOLESA_REMOTE_SANDBOX_ALLOWED_HOSTS = allowedHosts;

    return {
        apiBaseUrl,
        token,
        allowedHosts,
        expectedAccountId,
        envIdentity,
        credentialsPath: REMOTE_ENV_PATH,
    };
}

export function redactToken(token: string): string {
    if (!token) return '';
    return `${token.slice(0, 3)}…(len=${token.length})`;
}

export async function partnerGet(
    apiBaseUrl: string,
    token: string,
    pathSuffix: string,
): Promise<{ status: number; json: any }> {
    const url = `${apiBaseUrl.replace(/\/$/, '')}${pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            'XP-Api-Token': token,
        },
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
}

export async function partnerPost(
    apiBaseUrl: string,
    token: string,
    pathSuffix: string,
    body: unknown,
): Promise<{ status: number; json: any }> {
    const url = `${apiBaseUrl.replace(/\/$/, '')}${pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'XP-Api-Token': token,
        },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
}

/** Authoritative Sandbox identity: /me must report test_mode === true. */
export function assertRemoteSandboxIdentity(meData: any, expectedAccountId?: string): {
    testMode: boolean;
    accountId: string | number | undefined;
} {
    const data = meData?.data ?? meData;
    const testMode = Boolean(data?.test_mode);
    assert.equal(
        testMode,
        true,
        'SAFETY ABORT: /me.test_mode is not true — refusing to treat this account as official remote Sandbox',
    );
    const accountId = data?.account?.id ?? data?.account_id;
    if (expectedAccountId) {
        assert.equal(
            String(accountId),
            String(expectedAccountId),
            `SAFETY ABORT: account id mismatch (expected ${expectedAccountId})`,
        );
    }
    return { testMode, accountId };
}
