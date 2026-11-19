import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertSafePartnerHost, isSafePartnerHost } from '../util/safe-partner-host';

describe('assertSafePartnerHost', () => {
    it('allows local Partner hosts', () => {
        assert.equal(assertSafePartnerHost('http://127.0.0.1:8000/api/pcl/v1').hostname, '127.0.0.1');
        assert.equal(assertSafePartnerHost('http://localhost:8000/api/pcl/v1').hostname, 'localhost');
        assert.equal(isSafePartnerHost('http://127.0.0.1:8000/api/pcl/v1'), true);
    });

    it('rejects production-like and unknown hosts', () => {
        assert.throws(() => assertSafePartnerHost('https://api.bolesa.com/api/pcl/v1'));
        assert.throws(() => assertSafePartnerHost('https://partner.example.com/api/pcl/v1'));
        assert.throws(() => assertSafePartnerHost(''));
        assert.equal(isSafePartnerHost('https://api.bolesa.com/api/pcl/v1'), false);
    });
});
