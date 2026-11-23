import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CacheService } from '@vendure/core';

import { bolesaEligibilityChecker } from '../config/bolesa-eligibility-checker';
import { bolesaShippingCalculator } from '../config/bolesa-shipping-calculator';
import { BolesaApiError } from '../services/bolesa-client.service';
import { BolesaConnectionService } from '../services/bolesa-connection.service';
import { BolesaRateService, resolveCarrierSlug } from '../services/bolesa-rate.service';
import { BolesaServiceOption } from '../types';
import { pricePresence } from '../util/shipping-diagnostics';

const rateOptions = { apiBaseUrl: 'http://127.0.0.1:8000/api/pcl/v1', encryptionSecret: 'x' };

function order(countryCode = 'EG', hash = 'city-hash') {
    return {
        shippingAddress: {
            countryCode,
            fullName: 'Customer',
            phoneNumber: '010',
            streetLine1: '12 Test Street',
            city: 'Nasr City',
            customFields: hash ? { bolesaCityHash: hash } : {},
        },
        lines: [],
        subTotalWithTax: 1000,
        totalQuantity: 1,
        channels: [{ id: 1 }],
        customFields: { paymentPreference: 'prepaid' },
    } as any;
}

function connection(active = true, extra: Record<string, unknown> = {}) {
    return {
        requireActive: async () => {
            if (!active) {
                throw new Error('Bolesa connection is not configured or inactive for this channel');
            }
            return {
                shipperAddress: {
                    name: 'Warehouse',
                    phone: '010',
                    country_code: 'EG',
                    resolution_hash: 'shipper-hash',
                    address_line: 'Warehouse street, Cairo',
                },
                shipmentCategory: 'dry',
                markupPercent: 0,
                codFeeMode: 'absorb',
                allowOpen: false,
                enabledServiceSlugs: [],
                ...extra,
            };
        },
        authFor: () => ({ apiBaseUrl: rateOptions.apiBaseUrl, token: 'do-not-log' }),
    };
}

describe('price presence', () => {
    it('distinguishes null, undefined, zero, and positive', () => {
        assert.equal(pricePresence(null), 'null');
        assert.equal(pricePresence(undefined), 'undefined');
        assert.equal(pricePresence(0), 'zero');
        assert.equal(pricePresence(45.5), 'positive');
        assert.equal(pricePresence(Number.NaN), 'invalid');
    });
});

describe('BolesaRateService.buildQuote', () => {
    const rateService = new BolesaRateService({} as any, {} as any, rateOptions);

    it('returns undefined when Partner prices are null or missing', () => {
        const missing: BolesaServiceOption = { slug: 'bosta', ccPrice: undefined, codPrice: undefined };
        assert.equal(rateService.buildQuote(missing, 'prepaid', 0, 'absorb', 'EGP'), undefined);
    });

    it('keeps a legitimate zero as price 0 minor units', () => {
        const free: BolesaServiceOption = { slug: 'bosta', ccPrice: 0, codPrice: 0, currencyCode: 'EGP' };
        const built = rateService.buildQuote(free, 'prepaid', 0, 'absorb', 'EGP');
        assert.ok(built);
        assert.equal(built.priceMinor, 0);
    });

    it('refuses a priced quote whose currency is not the channel currency', () => {
        const sar: BolesaServiceOption = { slug: 'bosta', ccPrice: 11.4, codPrice: 11.4, currencyCode: 'SAR' };
        assert.equal(rateService.buildQuote(sar, 'prepaid', 0, 'absorb', 'EGP'), undefined);
        assert.equal(rateService.buildQuote(sar, 'prepaid', 0, 'absorb', 'USD'), undefined);
        const unnamed: BolesaServiceOption = { slug: 'bosta', ccPrice: 11.4, codPrice: 11.4 };
        assert.equal(rateService.buildQuote(unnamed, 'prepaid', 0, 'absorb', 'SAR'), undefined);
    });

    it('converts a positive major price to minor units', () => {
        const priced: BolesaServiceOption = { slug: 'bosta', ccPrice: 40, codPrice: 45, currencyCode: 'EGP' };
        const built = rateService.buildQuote(priced, 'prepaid', 0, 'absorb', 'EGP');
        assert.ok(built);
        assert.equal(built.priceMinor, 4000);
    });
});

describe('eligible shipping calculation', () => {
    async function wire(
        observe: (auth?: unknown, body?: any) => Promise<any> | any,
        cache?: { get: any; set: any },
        extra: Record<string, unknown> = {},
    ) {
        const client = { observeServiceOptions: observe };
        const conn = connection(true, extra);
        const rate = new BolesaRateService(conn as any, client as any, rateOptions);
        const boundCache = cache ?? {
            get: async () => undefined,
            set: async () => undefined,
        };
        rate.setCache(boundCache as any);
        await bolesaShippingCalculator.init({
            get(token: unknown) {
                if (token === BolesaRateService) {
                    return rate;
                }
                if (token === BolesaConnectionService) {
                    return conn;
                }
                if (token === CacheService) {
                    return boundCache;
                }
                return {};
            },
        } as any);
        return { rate, cache };
    }

    const ctx = { channelId: 1, channel: { defaultCurrencyCode: 'EGP' } } as any;
    const args = [
        { name: 'carrierServiceSlug', value: 'auto' },
        { name: 'flatRateFallbackMinor', value: '0' },
    ] as any;

    it('omits the method when cc_price and cod_price are null and does not cache that response', async () => {
        let cached = false;
        await wire(async () => ({
            httpStatus: 200,
            services: [{ slug: 'bosta_egy_dom_dry_std_dlv', ccPrice: undefined, codPrice: undefined }],
            rawPrices: [{ slug: 'bosta_egy_dom_dry_std_dlv', ccPrice: 'null', codPrice: 'null' }],
        }), {
            get: async () => undefined,
            set: async () => {
                cached = true;
            },
        });
        const result = await bolesaShippingCalculator.calculate(ctx, order(), args, {} as any);
        assert.equal(result, undefined);
        assert.equal(cached, false);
    });

    it('returns price 0 for a valid zero Partner price and caches it', async () => {
        let cached = false;
        await wire(async () => ({
            httpStatus: 200,
            services: [{ slug: 'bosta', ccPrice: 0, codPrice: 0, currencyCode: 'EGP' }],
            rawPrices: [{ slug: 'bosta', ccPrice: 'zero', codPrice: 'zero' }],
        }), {
            get: async () => undefined,
            set: async () => {
                cached = true;
            },
        });
        const result = await bolesaShippingCalculator.calculate(ctx, order(), args, {} as any);
        assert.ok(result);
        assert.equal(result.price, 0);
        assert.equal(cached, true);
    });

    it('returns a positive minor price for a valid Partner price', async () => {
        await wire(async () => ({
            httpStatus: 200,
            services: [{ slug: 'bosta', ccPrice: 40, codPrice: 45, currencyCode: 'EGP' }],
            rawPrices: [{ slug: 'bosta', ccPrice: 'positive', codPrice: 'positive' }],
        }));
        const result = await bolesaShippingCalculator.calculate(ctx, order(), args, {} as any);
        assert.ok(result);
        assert.equal(result.price, 4000);
        assert.notEqual(result.price, 0);
    });

    it('returns every priced carrier and charges the shopper-selected service', async () => {
        await wire(async () => ({
            httpStatus: 200,
            services: [
                { slug: 'jt', carrierName: 'J&T Express', label: 'J&T Express Egypt Standard', ccPrice: 77.61, codPrice: 77.61, currencyCode: 'EGP' },
                { slug: 'aramex', carrierName: 'Aramex', ccPrice: 95.54, codPrice: 95.54, currencyCode: 'EGP' },
                { slug: 'arrive', carrierName: 'Arrive', ccPrice: null, codPrice: null, currencyCode: 'EGP' },
                { slug: 'speedaf', carrierName: 'Speedaf', ccPrice: 80.37, codPrice: 80.37, currencyCode: 'EGP' },
            ],
            rawPrices: [],
        }));
        const selected = order();
        selected.customFields.bolesaServiceSlug = 'speedaf';
        const result = await bolesaShippingCalculator.calculate(ctx, selected, args, {} as any);
        assert.ok(result);
        assert.equal(result.price, 8037);
        const options = (result.metadata as any).options;
        assert.equal(options.length, 3);
        assert.deepEqual(options.map((choice: { slug: string; priceMinor: number }) => [choice.slug, choice.priceMinor]), [
            ['jt', 7761],
            ['aramex', 9554],
            ['speedaf', 8037],
        ]);
        assert.equal((result.metadata as any).serviceSlug, 'speedaf');
    });

    it('does not charge a SAR price on an EGP channel', async () => {
        await wire(async () => ({
            httpStatus: 200,
            services: [{ slug: 'bosta', ccPrice: 11.4, codPrice: 11.4, currencyCode: 'SAR' }],
            rawPrices: [{ slug: 'bosta', ccPrice: 'positive', codPrice: 'positive' }],
        }));
        const result = await bolesaShippingCalculator.calculate(ctx, order(), args, {} as any);
        assert.equal(result, undefined);
    });

    it('does not charge a price when Partner omits the currency', async () => {
        await wire(async () => ({
            httpStatus: 200,
            services: [{ slug: 'bosta', ccPrice: 11.4, codPrice: 11.4 }],
            rawPrices: [{ slug: 'bosta', ccPrice: 'positive', codPrice: 'positive' }],
        }));
        const result = await bolesaShippingCalculator.calculate(ctx, order(), args, {} as any);
        assert.equal(result, undefined);
    });

    it('charges a matching channel currency in minor units', async () => {
        await wire(async () => ({
            httpStatus: 200,
            services: [{ slug: 'bosta', ccPrice: 11.4, codPrice: 11.4, currencyCode: 'egp' }],
            rawPrices: [{ slug: 'bosta', ccPrice: 'positive', codPrice: 'positive' }],
        }));
        const result = await bolesaShippingCalculator.calculate(ctx, order(), args, {} as any);
        assert.ok(result);
        assert.equal(result.price, 1140);
        assert.equal((result.metadata as any).options[0].priceMinor, 1140);
    });

    it('sends the merchant allow-open policy and offers only enabled services', async () => {
        let body: any;
        await wire(
            async (_auth, sent) => {
                body = sent;
                return {
                    httpStatus: 200,
                    services: [
                        { slug: 'bosta', ccPrice: 11.4, codPrice: 11.4, currencyCode: 'EGP' },
                        { slug: 'aramex', ccPrice: 80, codPrice: 80, currencyCode: 'EGP' },
                    ],
                    rawPrices: [],
                };
            },
            undefined,
            { allowOpen: true, enabledServiceSlugs: ['aramex'], defaultServiceSlug: 'aramex' },
        );
        const result = await bolesaShippingCalculator.calculate(ctx, order(), args, {} as any);
        assert.equal(body.allow_open, true);
        assert.ok(result);
        assert.equal(result.price, 8000);
        assert.deepEqual((result.metadata as any).options.map((choice: { slug: string }) => choice.slug), ['aramex']);
    });

    it('still offers priced carriers when the default service has no quote', async () => {
        await wire(
            async () => ({
                httpStatus: 200,
                services: [
                    { slug: 'smsa', carrierName: 'Smsa', ccPrice: null, codPrice: null, currencyCode: 'EGP' },
                    { slug: 'aramex', carrierName: 'Aramex', ccPrice: 80, codPrice: 80, currencyCode: 'EGP' },
                ],
                rawPrices: [],
            }),
            undefined,
            { enabledServiceSlugs: ['smsa', 'aramex'], defaultServiceSlug: 'smsa' },
        );
        const result = await bolesaShippingCalculator.calculate(ctx, order(), args, {} as any);
        assert.ok(result);
        assert.equal(result.price, 8000);
        assert.deepEqual((result.metadata as any).options.map((choice: { slug: string }) => choice.slug), ['aramex']);
    });

    it('does not switch to another carrier when the selected service is disabled', async () => {
        await wire(
            async () => ({
                httpStatus: 200,
                services: [
                    { slug: 'bosta', ccPrice: 11.4, codPrice: 11.4, currencyCode: 'EGP' },
                    { slug: 'aramex', ccPrice: 80, codPrice: 80, currencyCode: 'EGP' },
                ],
                rawPrices: [],
            }),
            undefined,
            { enabledServiceSlugs: ['aramex'], defaultServiceSlug: 'aramex' },
        );
        const selected = order();
        selected.customFields.bolesaServiceSlug = 'bosta';
        const result = await bolesaShippingCalculator.calculate(ctx, selected, args, {} as any);
        assert.equal(result, undefined);
    });

    it('does not turn a Partner HTTP error into a zero shipping price', async () => {
        await wire(async () => {
            throw new BolesaApiError('http_500', 'Bolesa API error 500', 500);
        });
        const result = await bolesaShippingCalculator.calculate(ctx, order(), args, {} as any);
        assert.equal(result, undefined);
    });
});

describe('rate cache fingerprint', () => {
    it('changes when the channel currency changes', () => {
        const sample = order();
        const egp = BolesaRateService.orderFingerprint(sample, 'prepaid', 'EGP');
        const sar = BolesaRateService.orderFingerprint(sample, 'prepaid', 'SAR');
        assert.notEqual(egp, sar);
        const open = BolesaRateService.orderFingerprint(sample, 'prepaid', 'EGP', true);
        assert.notEqual(egp, open);
    });
});

describe('resolveCarrierSlug', () => {
    it('prefers the shopper choice over auto', () => {
        assert.equal(resolveCarrierSlug('speedaf', 'auto'), 'speedaf');
        assert.equal(resolveCarrierSlug('  ', 'auto'), 'auto');
        assert.equal(resolveCarrierSlug(undefined, undefined), 'auto');
    });
});

describe('bolesa eligibility checker', () => {
    async function init(active: boolean) {
        await bolesaEligibilityChecker.init({
            get() {
                return connection(active);
            },
        } as any);
    }

    it('fails when the city hash is missing', async () => {
        await init(true);
        const ok = await bolesaEligibilityChecker.check({} as any, order('EG', ''), [], {} as any);
        assert.equal(ok, false);
    });

    it('fails when the country is not Egypt', async () => {
        await init(true);
        const ok = await bolesaEligibilityChecker.check({} as any, order('AF'), [], {} as any);
        assert.equal(ok, false);
    });

    it('fails when the channel connection is inactive', async () => {
        await init(false);
        const ok = await bolesaEligibilityChecker.check({} as any, order('EG'), [], {} as any);
        assert.equal(ok, false);
    });

    it('passes for Egypt with a city hash and an active connection', async () => {
        await init(true);
        const ok = await bolesaEligibilityChecker.check({} as any, order('EG'), [], {} as any);
        assert.equal(ok, true);
    });
});
