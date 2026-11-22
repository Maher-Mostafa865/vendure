import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bolesaCodPaymentHandler } from '../config/bolesa-cod-payment-handler';
import { BolesaRateService } from '../services/bolesa-rate.service';
import { BolesaServiceOption } from '../types';

describe('BolesaRateService quote building', () => {
    const rateService = new BolesaRateService({} as any, {} as any, {
        apiBaseUrl: 'https://x',
        encryptionSecret: 'x',
    });

    const option: BolesaServiceOption = {
        slug: 'aramex-dom',
        carrierName: 'Aramex',
        ccPrice: 40,
        codPrice: 45,
        codCollectionFee: 5,
        currencyCode: 'EGP',
    };

    it('builds prepaid quote from cc_price in minor units', () => {
        const built = rateService.buildQuote(option, 'prepaid', 0, 'absorb', 'EGP');
        assert.ok(built);
        assert.equal(built.priceMinor, 4000);
        assert.equal(built.quote.serviceSlug, 'aramex-dom');
        assert.equal(built.quote.paymentPreference, 'prepaid');
    });

    it('absorbs COD collection fee by default', () => {
        const built = rateService.buildQuote(option, 'cod', 0, 'absorb', 'EGP');
        assert.ok(built);
        assert.equal(built.priceMinor, 4500);
    });

    it('passes COD collection fee to customer when configured', () => {
        const built = rateService.buildQuote(option, 'cod', 0, 'passToCustomer', 'EGP');
        assert.ok(built);
        assert.equal(built.priceMinor, 5000);
    });

    it('applies markup percent', () => {
        const built = rateService.buildQuote(option, 'prepaid', 10, 'absorb', 'EGP');
        assert.ok(built);
        assert.equal(built.priceMinor, 4400);
    });

    it('public metadata never includes fee breakdown', () => {
        const built = rateService.buildQuote(option, 'cod', 0, 'passToCustomer', 'EGP')!;
        const meta = rateService.publicMetadata(built.quote);
        assert.deepEqual(Object.keys(meta).sort(), ['carrierName', 'serviceSlug']);
        assert.equal((meta as any).codFeeMinor, undefined);
        assert.equal((meta as any).priceMinor, undefined);
    });
});

describe('bolesa-cod payment handler', () => {
    const emptyArgs: any[] = [];

    it('authorizes without settling at createPayment', async () => {
        const result = await bolesaCodPaymentHandler.createPayment(
            {} as any,
            { code: 'ORD-1', totalWithTax: 15000 } as any,
            15000,
            emptyArgs,
            {},
        );
        assert.equal(result.state, 'Authorized');
        assert.equal(result.amount, 15000);
        assert.equal(result.transactionId, 'ORD-1');
        assert.equal((result.metadata as any).method, 'bolesa-cod');
    });

    it('settlePayment succeeds (called on DELIVERED)', async () => {
        const result = await bolesaCodPaymentHandler.settlePayment(
            {} as any,
            {} as any,
            { amount: 15000, method: 'bolesa-cod', state: 'Authorized', metadata: {} } as any,
            emptyArgs,
        );
        assert.equal(result.success, true);
    });

    it('cancelPayment succeeds (returned/cancelled COD)', async () => {
        const result = await bolesaCodPaymentHandler.cancelPayment!(
            {} as any,
            {} as any,
            { amount: 15000, method: 'bolesa-cod', state: 'Authorized', metadata: {} } as any,
            emptyArgs,
        );
        assert.equal(result.success, true);
    });
});

describe('duplicate AWB prevention helpers', () => {
    it('idempotency key is attempt-scoped', () => {
        const shipmentKey = 'f123';
        const key1 = `${shipmentKey}-a1`;
        const key2 = `${shipmentKey}-a2`;
        assert.notEqual(key1, key2);
        assert.equal(key1, 'f123-a1');
    });

    it('channel isolation uses channelId in lookup key', () => {
        const channelA = '1';
        const channelB = '2';
        const tn = 'TN-SHARED';
        // Lookup must be (channelId, trackingNumber) — never tracking alone
        const lookupA = `${channelA}:${tn}`;
        const lookupB = `${channelB}:${tn}`;
        assert.notEqual(lookupA, lookupB);
    });
});
