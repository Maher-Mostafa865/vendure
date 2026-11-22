import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isValidPersistedOrderId } from '../util/create-awb-gate';

/**
 * Behavioral contract for onFulfillmentCreated order resolution.
 * Full Nest/DB resolution is covered in integration; these guard the fail-closed rules.
 */
describe('outbox order resolution contract (F-AWB-02)', () => {
    it('must not treat placeholder orderId 0 as valid for persistence', () => {
        const candidates = ['0', 0, '', null, undefined] as const;
        for (const c of candidates) {
            assert.equal(
                isValidPersistedOrderId(c as any),
                false,
                `placeholder ${String(c)} must be rejected`,
            );
        }
    });

    it('documents fail-closed policy: no outbox row without a valid order id', () => {
        // Simulated decision used by onFulfillmentCreated
        const resolvedOrderId: string | null = null;
        const shouldCreateOutbox = isValidPersistedOrderId(resolvedOrderId);
        assert.equal(shouldCreateOutbox, false);
    });

    it('allows outbox creation only when a real order id is resolved', () => {
        const resolvedOrderId = '99';
        assert.equal(isValidPersistedOrderId(resolvedOrderId), true);
    });
});
