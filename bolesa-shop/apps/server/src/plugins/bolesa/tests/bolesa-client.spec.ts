import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { BolesaApiError, BolesaClient, mapServiceOption } from '../services/bolesa-client.service';

function mockFetch(status: number, body: unknown) {
    return mock.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
        headers: new Headers(),
    })) as unknown as typeof fetch;
}

describe('BolesaClient', () => {
    const auth = { apiBaseUrl: 'https://api.test/api/pcl/v1', token: 'test-token' };
    let originalFetch: typeof fetch;

    afterEach(() => {
        if (originalFetch) {
            globalThis.fetch = originalFetch;
        }
    });

    it('maps null, zero, and positive service prices without turning null into zero', () => {
        const missing = mapServiceOption({ slug: 'bosta', cc_price: null, cod_price: null });
        assert.equal(missing.ccPrice, 'null');
        assert.equal(missing.codPrice, 'null');
        assert.equal(missing.option.ccPrice, undefined);
        assert.equal(missing.option.codPrice, undefined);

        const free = mapServiceOption({ slug: 'bosta', cc_price: 0, cod_price: 0 });
        assert.equal(free.ccPrice, 'zero');
        assert.equal(free.option.ccPrice, 0);
        assert.equal(free.option.codPrice, 0);

        const priced = mapServiceOption({
            slug: 'jt_express_egy_dom_dry_std_dlv',
            cc_price: 77.61,
            cod_price: 77.61,
            carrier: { name: 'J&T Express', logo: 'https://cdn.example/jt.png' },
            labels: { en: 'J&T Express Egypt Standard' },
            price: { fee_breakdown: { components: [{ code: 'shipping_fees', amount: 64.78 }] } },
        });
        assert.equal(priced.ccPrice, 'positive');
        assert.equal(priced.option.ccPrice, 77.61);
        assert.equal(priced.option.carrierName, 'J&T Express');
        assert.equal(priced.option.logoUrl, 'https://cdn.example/jt.png');
        assert.equal((priced.option as any).fee_breakdown, undefined);
    });

    it('observeServiceOptions reports HTTP 200 and raw null prices', async () => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch(200, {
            success: true,
            data: { services: [{ slug: 'bosta', cc_price: null, cod_price: null }] },
        });
        const client = new BolesaClient({ apiBaseUrl: auth.apiBaseUrl, encryptionSecret: 'x' });
        const observed = await client.observeServiceOptions(auth, { payment_type: 'cc' });
        assert.equal(observed.httpStatus, 200);
        assert.equal(observed.rawPrices[0].ccPrice, 'null');
        assert.equal(observed.rawPrices[0].codPrice, 'null');
        assert.equal(observed.services[0].ccPrice, undefined);
    });

    it('service options HTTP 500 throws and does not yield a zero price', async () => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch(500, { success: false, message: 'Bolesa API error 500' });
        const client = new BolesaClient({ apiBaseUrl: auth.apiBaseUrl, encryptionSecret: 'x' });
        await assert.rejects(
            () => client.serviceOptions(auth, { payment_type: 'cc' }),
            (err: unknown) => {
                assert.ok(err instanceof BolesaApiError);
                assert.equal(err.status, 500);
                assert.equal((err as any).price, undefined);
                return true;
            },
        );
    });

    it('maps successful service options', async () => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch(200, {
            success: true,
            data: {
                services: [
                    {
                        slug: 'aramex-dom',
                        carrier: { name: 'Aramex' },
                        cc_price: 45.5,
                        cod_price: 50,
                        cod_collection_fee: 5,
                    },
                ],
            },
        });
        const client = new BolesaClient({ apiBaseUrl: auth.apiBaseUrl, encryptionSecret: 'x' });
        const services = await client.serviceOptions(auth, { payment_type: 'cc' });
        assert.equal(services.length, 1);
        assert.equal(services[0].slug, 'aramex-dom');
        assert.equal(services[0].ccPrice, 45.5);
        assert.equal(services[0].codCollectionFee, 5);
    });

    it('maps AWB list when Partner returns a bare data array', async () => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch(200, {
            success: true,
            data: [{ tracking_number: 'TN-1', status_code: 'READY FOR SHIPMENT' }],
        });
        const client = new BolesaClient({ apiBaseUrl: auth.apiBaseUrl, encryptionSecret: 'x' });
        const awbs = await client.findAwbsByMeta(auth, 'vendure_shipment_key', 'k1');
        assert.equal(awbs.length, 1);
        assert.equal(awbs[0].trackingNumber, 'TN-1');
    });

    it('maps Partner geo cities that expose name_en / resolution_hash', async () => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch(200, {
            success: true,
            data: {
                cities: [
                    {
                        id: 33874,
                        name_en: 'ElHay 06 (Nasr City)',
                        name_ar: 'الحى السادس',
                        ancestors_label_en: 'ElHay 06 (Nasr City), Nasr City, Cairo',
                        resolution_hash: '4c2279956e07a68e2eacaeb97382d3e5',
                    },
                ],
            },
        });
        const client = new BolesaClient({ apiBaseUrl: auth.apiBaseUrl, encryptionSecret: 'x' });
        const cities = await client.searchCities(auth, 'Nasr');
        assert.equal(cities.length, 1);
        assert.equal(cities[0].name, 'ElHay 06 (Nasr City)');
        assert.equal(cities[0].resolutionHash, '4c2279956e07a68e2eacaeb97382d3e5');
    });

    it('throws typed error on 422 definite failure', async () => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch(422, {
            success: false,
            code: 'carrier_rejected',
            message: 'Address invalid',
        });
        const client = new BolesaClient({ apiBaseUrl: auth.apiBaseUrl, encryptionSecret: 'x' });
        await assert.rejects(
            () => client.createAwb(
                auth,
                {
                    orderNumber: 'T1',
                    carrierServiceSlug: 'x',
                    shipmentType: 'domestic',
                    shipmentOperation: 'ship',
                    shipmentCategory: 'dry',
                    paymentType: 'cc',
                    weightKg: 1,
                    shipper: {
                        name: 'A',
                        phone: '1',
                        country_code: 'EG',
                        resolution_hash: 'h1',
                        address_line: 'x',
                    },
                    consignee: {
                        name: 'B',
                        phone: '2',
                        country_code: 'EG',
                        resolution_hash: 'h2',
                        address_line: 'y',
                    },
                    meta: { vendure_shipment_key: 'f1' },
                },
                'f1-a1',
            ),
            (err: unknown) => {
                assert.ok(err instanceof BolesaApiError);
                assert.equal(err.code, 'carrier_rejected');
                assert.equal(err.status, 422);
                assert.equal(err.isDefiniteFailure, true);
                assert.equal(err.isRetryable, false);
                return true;
            },
        );
    });

    it('marks 409 and 5xx as retryable', async () => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch(409, {
            success: false,
            code: 'idempotency_in_progress',
            message: 'in progress',
        });
        const client = new BolesaClient({ apiBaseUrl: auth.apiBaseUrl, encryptionSecret: 'x' });
        try {
            await client.getAwb(auth, 'TN1');
            assert.fail('expected throw');
        } catch (e: any) {
            assert.ok(e instanceof BolesaApiError);
            assert.equal(e.isRetryable, true);
            assert.equal(e.isDefiniteFailure, false);
        }
    });

    it('returns queued status on 202', async () => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch(202, {
            success: true,
            data: { status: 'queued', correlation_id: 'c-1' },
        });
        const client = new BolesaClient({ apiBaseUrl: auth.apiBaseUrl, encryptionSecret: 'x' });
        const result = await client.createAwb(
            auth,
            {
                orderNumber: 'T1',
                carrierServiceSlug: 'x',
                shipmentType: 'domestic',
                shipmentOperation: 'ship',
                shipmentCategory: 'dry',
                paymentType: 'cc',
                weightKg: 1,
                shipper: {
                    name: 'A',
                    phone: '1',
                    country_code: 'EG',
                    resolution_hash: 'h1',
                    address_line: 'x',
                },
                consignee: {
                    name: 'B',
                    phone: '2',
                    country_code: 'EG',
                    resolution_hash: 'h2',
                    address_line: 'y',
                },
                meta: { vendure_shipment_key: 'f1' },
            },
            'f1-a1',
        );
        assert.equal(result.status, 'queued');
        assert.equal(result.correlationId, 'c-1');
    });

    it('sends Idempotency-Key and XP-Api-Token headers', async () => {
        originalFetch = globalThis.fetch;
        let seenHeaders: Record<string, string> = {};
        globalThis.fetch = mock.fn(async (_url: string, init?: RequestInit) => {
            seenHeaders = init?.headers as Record<string, string>;
            return {
                ok: true,
                status: 201,
                text: async () =>
                    JSON.stringify({
                        success: true,
                        data: { awbs: [{ tracking_number: 'TN999', status_code: 'READY FOR SHIPMENT' }] },
                    }),
                headers: new Headers(),
            };
        }) as unknown as typeof fetch;

        const client = new BolesaClient({ apiBaseUrl: auth.apiBaseUrl, encryptionSecret: 'x' });
        const result = await client.createAwb(
            auth,
            {
                orderNumber: 'T1',
                carrierServiceSlug: 'x',
                shipmentType: 'domestic',
                shipmentOperation: 'ship',
                shipmentCategory: 'dry',
                paymentType: 'cod',
                codAmount: 150.5,
                weightKg: 1,
                shipper: {
                    name: 'A',
                    phone: '1',
                    country_code: 'EG',
                    resolution_hash: 'h1',
                    address_line: 'x',
                },
                consignee: {
                    name: 'B',
                    phone: '2',
                    country_code: 'EG',
                    resolution_hash: 'h2',
                    address_line: 'y',
                },
                meta: { vendure_shipment_key: 'f42' },
            },
            'f42-a1',
        );
        assert.equal(result.awbs[0].trackingNumber, 'TN999');
        assert.equal(seenHeaders['XP-Api-Token'], 'test-token');
        assert.equal(seenHeaders['Idempotency-Key'], 'f42-a1');
    });
});
