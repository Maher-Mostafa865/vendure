import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    assertOfficialRemoteSandboxHost,
    isOfficialRemoteSandboxHost,
    parseRemoteSandboxAllowedHosts,
} from '../util/safe-remote-sandbox-host';

describe('assertOfficialRemoteSandboxHost', () => {
    const allow = 'sandbox.partner.example.com';

    it('allows an explicitly allowlisted https host', () => {
        const u = assertOfficialRemoteSandboxHost(
            `https://${allow}/api/pcl/v1`,
            allow,
        );
        assert.equal(u.hostname, allow);
        assert.equal(isOfficialRemoteSandboxHost(`https://${allow}/api/pcl/v1`, allow), true);
    });

    it('rejects localhost / local Partner hosts', () => {
        assert.throws(() =>
            assertOfficialRemoteSandboxHost('http://127.0.0.1:8000/api/pcl/v1', allow),
        );
        assert.throws(() =>
            assertOfficialRemoteSandboxHost('https://localhost/api/pcl/v1', allow),
        );
    });

    it('rejects http even for allowlisted hosts', () => {
        assert.throws(() =>
            assertOfficialRemoteSandboxHost(`http://${allow}/api/pcl/v1`, allow),
        );
    });

    it('rejects hosts not on the allowlist', () => {
        assert.throws(() =>
            assertOfficialRemoteSandboxHost('https://api.bolesa.com/api/pcl/v1', allow),
        );
        assert.equal(
            isOfficialRemoteSandboxHost('https://api.bolesa.com/api/pcl/v1', allow),
            false,
        );
    });

    it('rejects empty allowlist', () => {
        assert.throws(() =>
            assertOfficialRemoteSandboxHost(`https://${allow}/api/pcl/v1`, ''),
        );
    });

    it('parseRemoteSandboxAllowedHosts rejects local entries', () => {
        assert.throws(() => parseRemoteSandboxAllowedHosts('127.0.0.1,sandbox.example.com'));
    });
});
