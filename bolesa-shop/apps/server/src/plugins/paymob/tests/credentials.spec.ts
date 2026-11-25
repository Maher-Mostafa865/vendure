import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymobConnection } from '../entities/paymob-connection.entity';
import {
    assertCredentialsComplete,
    decryptCredentials,
    mergeCredentialInput,
    pickStoredCredentials,
    resolveIntegrationId,
} from '../util/credentials';

describe('paymob credentials', () => {
    it('picks test or live stored credentials from mode', () => {
        const conn = new PaymobConnection({
            mode: 'test',
            testCredentials: {
                baseUrl: 'https://accept.paymob.com',
                apiKeyEncrypted: 'enc-test-api',
                secretKeyEncrypted: 'enc-test-secret',
                hmacSecretEncrypted: 'enc-test-hmac',
                publicKey: 'pk_test',
                apiKeyLast4: 'tapi',
                secretKeyLast4: 'tsec',
                hmacSecretLast4: 'thmc',
                integrationIdsByCurrency: { EGP: '1' },
                iframeId: null,
            },
            liveCredentials: {
                baseUrl: 'https://accept.paymob.com',
                apiKeyEncrypted: 'enc-live-api',
                secretKeyEncrypted: 'enc-live-secret',
                hmacSecretEncrypted: 'enc-live-hmac',
                publicKey: 'pk_live',
                apiKeyLast4: 'lapi',
                secretKeyLast4: 'lsec',
                hmacSecretLast4: 'lhmc',
                integrationIdsByCurrency: { EGP: '9' },
                iframeId: null,
            },
        });

        assert.equal(pickStoredCredentials(conn)?.publicKey, 'pk_test');
        conn.mode = 'live';
        assert.equal(pickStoredCredentials(conn)?.publicKey, 'pk_live');
        assert.equal(pickStoredCredentials(conn, 'test')?.publicKey, 'pk_test');
    });

    it('resolves integration id by currency with fallback', () => {
        assert.equal(resolveIntegrationId('egp', { EGP: '4625026', SAR: '5607328' }), '4625026');
        assert.equal(resolveIntegrationId('SAR', { EGP: '1' }, '99'), '99');
        assert.equal(resolveIntegrationId('USD', {}), null);
    });

    it('merges credential input and encrypts secrets', () => {
        const encrypt = (v: string) => `enc:${v}`;
        const stored = mergeCredentialInput(
            null,
            {
                baseUrl: 'https://accept.paymob.com/',
                apiKey: 'api-key-value',
                secretKey: 'secret-key-value',
                hmacSecret: 'hmac-secret-value',
                publicKey: 'pk_test',
                integrationIdsByCurrency: { egp: 4625026, sar: '' },
            },
            encrypt,
        );
        assert.ok(stored);
        assert.equal(stored!.baseUrl, 'https://accept.paymob.com');
        assert.equal(stored!.apiKeyEncrypted, 'enc:api-key-value');
        assert.equal(stored!.apiKeyLast4, 'alue');
        assert.deepEqual(stored!.integrationIdsByCurrency, { EGP: '4625026' });

        const active = decryptCredentials(stored!, c => c.replace(/^enc:/, ''));
        assert.equal(active.apiKey, 'api-key-value');
        assert.equal(active.secretKey, 'secret-key-value');
        assertCredentialsComplete(active);
    });

    it('keeps previous secrets when input omits them', () => {
        const existing = mergeCredentialInput(
            null,
            {
                apiKey: 'aaaa',
                secretKey: 'bbbb',
                hmacSecret: 'cccc',
                publicKey: 'pk',
            },
            v => `enc:${v}`,
        )!;
        const next = mergeCredentialInput(
            existing,
            { publicKey: 'pk2', integrationIdsByCurrency: { EGP: '1' } },
            v => `enc:${v}`,
        )!;
        assert.equal(next.apiKeyEncrypted, existing.apiKeyEncrypted);
        assert.equal(next.publicKey, 'pk2');
        assert.deepEqual(next.integrationIdsByCurrency, { EGP: '1' });
    });
});
