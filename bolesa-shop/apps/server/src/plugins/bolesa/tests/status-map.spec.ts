import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    isTerminalBolesaStatus,
    mapBolesaStatusToFulfillmentTarget,
    shouldIgnoreAsStale,
    statusRank,
} from '../util/status-map';

describe('status map', () => {
    it('maps forward statuses to Vendure targets', () => {
        assert.equal(mapBolesaStatusToFulfillmentTarget('PICKED UP'), 'Shipped');
        assert.equal(mapBolesaStatusToFulfillmentTarget('IN TRANSIT'), 'Shipped');
        assert.equal(mapBolesaStatusToFulfillmentTarget('DELIVERED'), 'Delivered');
        assert.equal(mapBolesaStatusToFulfillmentTarget('CANCELED'), 'Cancelled');
        assert.equal(mapBolesaStatusToFulfillmentTarget('RETURNED'), 'Returned');
        assert.equal(mapBolesaStatusToFulfillmentTarget('READY FOR SHIPMENT'), null);
        assert.equal(mapBolesaStatusToFulfillmentTarget('ABNORMAL'), null);
    });

    it('ranks statuses for forward-only comparison', () => {
        assert.ok(statusRank('DELIVERED') > statusRank('IN TRANSIT'));
        assert.ok(statusRank('CANCELED') > statusRank('DELIVERED'));
    });

    it('ignores stale backward statuses', () => {
        assert.equal(shouldIgnoreAsStale('READY FOR SHIPMENT', 'IN TRANSIT', undefined, undefined), true);
        assert.equal(shouldIgnoreAsStale('DELIVERED', 'IN TRANSIT', undefined, undefined), false);
        const older = new Date('2026-01-01');
        const newer = new Date('2026-01-02');
        assert.equal(shouldIgnoreAsStale('DELIVERED', 'PICKED UP', older, newer), true);
    });

    it('detects terminal statuses', () => {
        assert.equal(isTerminalBolesaStatus('DELIVERED'), true);
        assert.equal(isTerminalBolesaStatus('CANCELED'), true);
        assert.equal(isTerminalBolesaStatus('IN TRANSIT'), false);
    });
});
