import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chargedShippingQuote, codMeetsMinimum, evaluateCodPayment, quoteCustomerShipping } from '../util/service-offer';

const services = [
    { slug: 'aramex', ccPrice: 80, codPrice: 90, currencyCode: 'EGP' },
    { slug: 'speedaf', ccPrice: 50, codPrice: 55, currencyCode: 'EGP' },
    { slug: 'bosta', ccPrice: 40, codPrice: null, currencyCode: 'EGP' },
    { slug: 'foreign', ccPrice: 10, codPrice: 10, currencyCode: 'SAR' },
];

describe('quoteCustomerShipping', () => {
    it('uses the highest priority enabled service and adds profit to the carrier price', () => {
        const quote = quoteCustomerShipping({
            services,
            enabledSlugs: ['aramex', 'speedaf', 'bosta'],
            offers: [
                { slug: 'aramex', priority: 2, profitMinor: 0 },
                { slug: 'speedaf', priority: 1, profitMinor: 1500 },
            ],
            preference: 'prepaid',
            currencyCode: 'EGP',
        });
        assert.ok(quote);
        assert.equal(quote.slug, 'speedaf');
        assert.equal(quote.carrierPriceMinor, 5000);
        assert.equal(quote.profitMinor, 1500);
        assert.equal(quote.customerPriceMinor, 6500);
    });

    it('recalculates from the payment type: cash on delivery uses codPrice, card uses ccPrice', () => {
        const offers = [{ slug: 'speedaf', priority: 1, profitMinor: 200 }];
        const card = quoteCustomerShipping({
            services,
            enabledSlugs: ['speedaf', 'aramex'],
            offers,
            preference: 'prepaid',
            currencyCode: 'EGP',
        });
        const cash = quoteCustomerShipping({
            services,
            enabledSlugs: ['speedaf', 'aramex'],
            offers,
            preference: 'cod',
            currencyCode: 'EGP',
        });
        assert.equal(card?.customerPriceMinor, 5200);
        assert.equal(cash?.customerPriceMinor, 5700);
        assert.equal(card?.slug, 'speedaf');
        assert.equal(cash?.slug, 'speedaf');
    });

    it('charges the carrier price plus profit once', () => {
        const quote = quoteCustomerShipping({
            services,
            enabledSlugs: ['speedaf'],
            offers: [{ slug: 'speedaf', priority: 1, profitMinor: 500 }],
            preference: 'prepaid',
            currencyCode: 'EGP',
        });
        assert.ok(quote);
        assert.equal(quote.carrierPriceMinor, 5000);
        assert.equal(quote.customerPriceMinor, 5500);
    });

    it('skips a service the payment type cannot price and a service that is not enabled', () => {
        const quote = quoteCustomerShipping({
            services,
            enabledSlugs: ['bosta', 'foreign'],
            offers: [],
            preference: 'cod',
            currencyCode: 'EGP',
        });
        assert.equal(quote, undefined);
    });

    it('offers nothing when the merchant has not enabled a service', () => {
        const quote = quoteCustomerShipping({
            services,
            enabledSlugs: [],
            offers: [],
            preference: 'prepaid',
            currencyCode: 'EGP',
        });
        assert.equal(quote, undefined);
    });
});

describe('chargedShippingQuote', () => {
    it('keeps the charged price and does not add profit a second time', () => {
        const stored = chargedShippingQuote({
            quoted: {
                slug: 'speedaf',
                carrierPriceMinor: 5000,
                profitMinor: 1500,
                customerPriceMinor: 6500,
                currencyCode: 'EGP',
            },
            chargedMinor: 6500,
        });
        assert.equal(stored.priceMinor, 6500);
        assert.equal(stored.carrierPriceMinor, 5000);
        assert.equal(stored.profitMinor, 1500);
        assert.equal(stored.priceMinor, stored.carrierPriceMinor + stored.profitMinor);
    });

    it('does not replace the charged price when a later carrier would cost more', () => {
        const stored = chargedShippingQuote({
            quoted: {
                slug: 'speedaf',
                carrierPriceMinor: 8000,
                profitMinor: 1500,
                customerPriceMinor: 9500,
                currencyCode: 'EGP',
            },
            chargedMinor: 6500,
        });
        assert.equal(stored.priceMinor, 6500);
        assert.equal(stored.carrierPriceMinor, 8000);
        assert.equal(stored.profitMinor, 1500);
    });
});

describe('evaluateCodPayment', () => {
    const allowed = {
        codEnabled: true,
        subTotalWithTax: 100_000,
        minimumMinor: 100_000,
        paymentPreference: 'cod',
        quotedMinor: 6500,
        chargedMinor: 6500,
    };

    it('allows cash on delivery only when the goods total, preference, and charged price agree', () => {
        assert.equal(evaluateCodPayment(allowed).ok, true);
        assert.equal(evaluateCodPayment({ ...allowed, subTotalWithTax: 99_999 }).ok, false);
        assert.equal(evaluateCodPayment({ ...allowed, paymentPreference: 'prepaid' }).ok, false);
        assert.equal(evaluateCodPayment({ ...allowed, chargedMinor: 5000 }).ok, false);
        assert.equal(evaluateCodPayment({ ...allowed, codEnabled: false }).ok, false);
    });
});

describe('codMeetsMinimum', () => {
    it('allows cash on delivery only at or above the configured goods total', () => {
        assert.equal(codMeetsMinimum(99_999, 1000), false);
        assert.equal(codMeetsMinimum(100_000, 1000), true);
        assert.equal(codMeetsMinimum(150_000, 1000), true);
    });
});
