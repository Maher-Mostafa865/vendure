import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideCreateAwbGate, isValidPersistedOrderId } from '../util/create-awb-gate';

const base = {
    shipmentKey: 'f1',
    idempotencyKey: 'f1-a1',
    orderId: '42',
    attempt: 1,
    trackingNumber: null as string | null,
};

describe('decideCreateAwbGate', () => {
    it('requested → proceed (eligible for Partner create)', () => {
        const d = decideCreateAwbGate({ ...base, syncStatus: 'requested' });
        assert.equal(d.kind, 'proceed');
    });

    it('awaiting_bolesa → awaiting_lookup (no new create)', () => {
        const d = decideCreateAwbGate({ ...base, syncStatus: 'awaiting_bolesa' });
        assert.equal(d.kind, 'awaiting_lookup');
        if (d.kind === 'awaiting_lookup') {
            assert.equal(d.shipmentKey, 'f1');
        }
    });

    it('cancel_requested → terminal (never create)', () => {
        const d = decideCreateAwbGate({ ...base, syncStatus: 'cancel_requested' });
        assert.equal(d.kind, 'terminal');
        if (d.kind === 'terminal') {
            assert.equal(d.reason, 'cancel_requested');
        }
    });

    it('created with tracking → done', () => {
        const d = decideCreateAwbGate({
            ...base,
            syncStatus: 'created',
            trackingNumber: 'TN-1',
        });
        assert.equal(d.kind, 'done');
        if (d.kind === 'done') {
            assert.equal(d.trackingNumber, 'TN-1');
        }
    });

    it('created without tracking → awaiting_lookup (never blind POST /awbs)', () => {
        const d = decideCreateAwbGate({ ...base, syncStatus: 'created', trackingNumber: null });
        assert.equal(d.kind, 'awaiting_lookup');
    });

    it('cancel_retry_exhausted → terminal', () => {
        const d = decideCreateAwbGate({ ...base, syncStatus: 'cancel_retry_exhausted' });
        assert.equal(d.kind, 'terminal');
    });

    it('failed → terminal (Admin retry must reset to requested first)', () => {
        const d = decideCreateAwbGate({ ...base, syncStatus: 'failed' });
        assert.equal(d.kind, 'terminal');
        if (d.kind === 'terminal') {
            assert.equal(d.reason, 'failed');
        }
    });

    it('retry_exhausted → terminal (Admin retry restores requested)', () => {
        const d = decideCreateAwbGate({ ...base, syncStatus: 'retry_exhausted' });
        assert.equal(d.kind, 'terminal');
        if (d.kind === 'terminal') {
            assert.equal(d.reason, 'retry_exhausted');
        }
    });

    it('abandoned → terminal', () => {
        const d = decideCreateAwbGate({ ...base, syncStatus: 'abandoned' });
        assert.equal(d.kind, 'terminal');
    });

    it('canceled → terminal', () => {
        const d = decideCreateAwbGate({ ...base, syncStatus: 'canceled' });
        assert.equal(d.kind, 'terminal');
    });
});

describe('isValidPersistedOrderId', () => {
    it('rejects fabricated zero / empty placeholders', () => {
        assert.equal(isValidPersistedOrderId('0'), false);
        assert.equal(isValidPersistedOrderId(0 as any), false);
        assert.equal(isValidPersistedOrderId(''), false);
        assert.equal(isValidPersistedOrderId(null), false);
        assert.equal(isValidPersistedOrderId(undefined), false);
        assert.equal(isValidPersistedOrderId('   '), false);
    });

    it('accepts real order ids', () => {
        assert.equal(isValidPersistedOrderId('1'), true);
        assert.equal(isValidPersistedOrderId(42), true);
        assert.equal(isValidPersistedOrderId('abc-uuid'), true);
    });
});
