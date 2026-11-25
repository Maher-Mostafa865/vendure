import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
    buildPaymobHmacMessage,
    extractPaymobTransactionPayload,
    isPaymobSuccess,
    PAYMOB_HMAC_FIELDS,
    verifyPaymobHmac,
} from '../util/hmac';

function samplePayload(): Record<string, unknown> {
    return {
        amount_cents: 1000,
        created_at: '2024-01-01T00:00:00',
        currency: 'EGP',
        error_occured: false,
        has_parent_transaction: false,
        id: 123,
        integration_id: 4625026,
        is_3d_secure: false,
        is_auth: false,
        is_capture: false,
        is_refunded: false,
        is_standalone_payment: true,
        is_voided: false,
        order: { id: 999 },
        owner: 1,
        pending: false,
        source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
        success: true,
    };
}

describe('paymob hmac', () => {
    it('builds the ordered message from documented fields', () => {
        const message = buildPaymobHmacMessage(samplePayload());
        assert.ok(message.includes('1000'));
        assert.ok(message.includes('EGP'));
        assert.ok(message.includes('999'));
        assert.equal(PAYMOB_HMAC_FIELDS.length, 20);
    });

    it('verifies a valid HMAC and rejects a bad one', () => {
        const payload = samplePayload();
        const secret = 'test-hmac-secret';
        const hmac = createHmac('sha512', secret).update(buildPaymobHmacMessage(payload)).digest('hex');
        assert.equal(verifyPaymobHmac(payload, hmac, secret), true);
        assert.equal(verifyPaymobHmac(payload, 'deadbeef', secret), false);
        assert.equal(verifyPaymobHmac(payload, hmac, 'other'), false);
    });

    it('extracts nested obj payloads from POST callbacks', () => {
        const payload = samplePayload();
        const { payload: extracted, hmac } = extractPaymobTransactionPayload(
            { obj: payload, hmac: 'abc' },
            {},
        );
        assert.equal(extracted.id, 123);
        assert.equal(hmac, 'abc');
        assert.equal(isPaymobSuccess(extracted), true);
    });
});
