import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Mirrors Partner API Idempotency-Key rules (8–128 of [A-Za-z0-9_.:-]). */
function isValidPartnerIdempotencyKey(key: string): boolean {
    return /^[A-Za-z0-9_.:-]{8,128}$/.test(key);
}

describe('Partner Idempotency-Key shape', () => {
    it('rejects short outbox keys that previously broke create AWB', () => {
        assert.equal(isValidPartnerIdempotencyKey('f7-a1'), false);
        assert.equal(isValidPartnerIdempotencyKey('f12-a1'), false);
    });

    it('accepts channel-scoped bolesa shipment keys', () => {
        const shipmentKey = `bolesa-f12-c9`;
        const idempotencyKey = `${shipmentKey}-a1`;
        assert.equal(isValidPartnerIdempotencyKey(idempotencyKey), true);
        assert.equal(isValidPartnerIdempotencyKey(`cancel-${shipmentKey}-a1`), true);
    });
});
