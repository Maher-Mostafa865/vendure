/**
 * Shared helpers for full Shop → Fulfillment → Worker → Partner E2E.
 * DB target: vendure-bolesa-test only. Partner host must pass assertSafePartnerHost.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { GlobalFlag } from '@vendure/common/lib/generated-types';
import {
    ChannelService,
    CountryService,
    CurrencyCode,
    LanguageCode,
    PaymentMethodService,
    ProductService,
    ProductVariantService,
    RequestContextService,
    ShippingMethodService,
    StockLocationService,
    TaxCategoryService,
    TaxRateService,
    ZoneService,
} from '@vendure/core';
import type { INestApplicationContext } from '@nestjs/common';
import pg, { Client as PgClient, ClientConfig as PgClientConfig } from 'pg';

import {
    BOLESA_COD_HANDLER_CODE,
    BOLESA_ELIGIBILITY_CHECKER_CODE,
    BOLESA_FULFILLMENT_HANDLER_CODE,
    BOLESA_SHIPPING_CALCULATOR_CODE,
} from '../../constants';
import { BolesaConnectionService } from '../../services/bolesa-connection.service';
import { assertSafePartnerHost } from '../../util/safe-partner-host';
import { assertTestDatabaseName, REQUIRED_TEST_DB } from './assert-test-db';

export const SHIP_HASH = '4c2279956e07a68e2eacaeb97382d3e5';
export const CONS_HASH = '63f280b28984f4b7630deec7c0286828';
export const SERVICE_SLUG = 'bosta_egy_dom_dry_std_dlv';

export function loadSandboxCredentials(): { apiBaseUrl: string; token: string } {
    const sandboxPath = path.resolve(__dirname, '../../../../../../../.env.sandbox');
    if (!fs.existsSync(sandboxPath)) {
        throw new Error(`SAFETY ABORT: missing ${sandboxPath}`);
    }
    const parsed = loadDotenv({ path: sandboxPath }).parsed ?? {};
    const apiBaseUrl = String(parsed.BOLESA_API_BASE_URL || '').trim().replace(/\/$/, '');
    const token = String(parsed.BOLESA_PARTNER_TOKEN || '').trim();
    assertSafePartnerHost(apiBaseUrl);
    if (!token.startsWith('xp_')) {
        throw new Error('SAFETY ABORT: BOLESA_PARTNER_TOKEN missing or unexpected shape');
    }
    return { apiBaseUrl, token };
}

export function pgConfig(): PgClientConfig {
    assertTestDatabaseName(process.env.DB_NAME);
    return {
        host: process.env.DB_HOST || '127.0.0.1',
        port: +(process.env.DB_PORT || 6543),
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: REQUIRED_TEST_DB,
    };
}

export async function withPgClient<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = new pg.Client(pgConfig());
    await client.connect();
    try {
        const db = String(
            (await client.query<{ current_database: string }>('SELECT current_database()')).rows[0]
                .current_database,
        );
        assertTestDatabaseName(db);
        return await fn(client);
    } finally {
        await client.end();
    }
}

export async function waitUntil<T>(
    label: string,
    fn: () => Promise<T | null | undefined | false>,
    opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const intervalMs = opts?.intervalMs ?? 750;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = await fn();
        if (value) {
            return value as T;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Timeout waiting for ${label} after ${timeoutMs}ms`);
}

export async function shopGql(
    port: number,
    channelToken: string,
    query: string,
    variables?: Record<string, unknown>,
    authToken?: string,
): Promise<{ data?: any; errors?: any[]; token?: string }> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'vendure-token': channelToken,
    };
    if (authToken) {
        headers.authorization = `Bearer ${authToken}`;
    }
    const res = await fetch(`http://127.0.0.1:${port}/shop-api`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as any;
    const setCookie = res.headers.get('vendure-auth-token') || res.headers.get('Vendure-Auth-Token');
    return { ...json, token: setCookie || authToken };
}

export async function adminGql(
    port: number,
    channelToken: string,
    query: string,
    variables?: Record<string, unknown>,
    authToken?: string,
): Promise<{ data?: any; errors?: any[]; token?: string }> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'vendure-token': channelToken,
    };
    if (authToken) {
        headers.authorization = `Bearer ${authToken}`;
    }
    const res = await fetch(`http://127.0.0.1:${port}/admin-api`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as any;
    const setCookie = res.headers.get('vendure-auth-token') || res.headers.get('Vendure-Auth-Token');
    return { ...json, token: setCookie || authToken };
}

export interface SeedResult {
    channelId: number;
    channelToken: string;
    variantId: string;
    shippingMethodId: string;
    codPaymentMethodId: string;
    dummyPaymentMethodId: string;
}

/**
 * Seed minimal catalog + Bolesa shipping/COD methods on an isolated channel.
 * Uses Vendure services (setup only — checkout itself goes through Shop API).
 */
export async function seedFullE2eCatalog(
    app: INestApplicationContext,
    sandbox: { apiBaseUrl: string; token: string },
): Promise<SeedResult> {
    const requestContextService = app.get(RequestContextService);
    const channelService = app.get(ChannelService);
    const countryService = app.get(CountryService);
    const zoneService = app.get(ZoneService);
    const taxCategoryService = app.get(TaxCategoryService);
    const taxRateService = app.get(TaxRateService);
    const productService = app.get(ProductService);
    const productVariantService = app.get(ProductVariantService);
    const shippingMethodService = app.get(ShippingMethodService);
    const paymentMethodService = app.get(PaymentMethodService);
    const stockLocationService = app.get(StockLocationService);
    const connectionService = app.get(BolesaConnectionService);

    // Superadmin ctx on default channel first
    let ctx = await requestContextService.create({ apiType: 'admin' });

    // Country EG
    const countries = await countryService.findAll(ctx);
    let eg = countries.items.find(c => c.code === 'EG');
    if (!eg) {
        eg = await countryService.create(ctx, {
            code: 'EG',
            enabled: true,
            translations: [{ languageCode: LanguageCode.en, name: 'Egypt' }],
        });
    }

    // Zone covering EG
    let zones = await zoneService.findAll(ctx);
    let zone = zones.items.find(z => z.name === 'Bolesa EG Zone');
    if (!zone) {
        zone = await zoneService.create(ctx, { name: 'Bolesa EG Zone' });
        await zoneService.addMembersToZone(ctx, { zoneId: zone.id, memberIds: [eg.id] });
    }

    // Tax
    let taxCats = await taxCategoryService.findAll(ctx);
    let taxCat = taxCats.items[0];
    if (!taxCat) {
        taxCat = await taxCategoryService.create(ctx, {
            name: 'Standard',
            isDefault: true,
        });
    }
    const taxRates = await taxRateService.findAll(ctx);
    if (!taxRates.items.length) {
        await taxRateService.create(ctx, {
            name: 'Zero EG',
            enabled: true,
            value: 0,
            categoryId: taxCat.id,
            zoneId: zone.id,
        });
    }

    const channelCode = 'bolesa-full-e2e';
    const channelToken = 'token-bolesa-full-e2e';
    let channel = (await channelService.findAll(ctx)).items.find(c => c.code === channelCode);
    if (!channel) {
        const createdChannel = await channelService.create(ctx, {
            code: channelCode,
            token: channelToken,
            defaultLanguageCode: LanguageCode.en,
            availableLanguageCodes: [LanguageCode.en],
            defaultCurrencyCode: CurrencyCode.EGP,
            availableCurrencyCodes: [CurrencyCode.EGP],
            pricesIncludeTax: true,
            defaultTaxZoneId: zone.id,
            defaultShippingZoneId: zone.id,
        } as any);
        if ((createdChannel as any).errorCode) {
            throw new Error(`channel create failed: ${JSON.stringify(createdChannel)}`);
        }
        channel = createdChannel as any;
    } else {
        // Ensure zones assigned
        await channelService.update(ctx, {
            id: channel.id,
            defaultTaxZoneId: zone.id,
            defaultShippingZoneId: zone.id,
            defaultCurrencyCode: CurrencyCode.EGP,
        } as any);
    }
    assert.ok(channel, 'channel required');

    ctx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: channel,
    });

    // Bolesa connection for this channel
    await connectionService.upsert(ctx, {
        apiBaseUrl: sandbox.apiBaseUrl,
        token: sandbox.token,
        shipperAddress: {
            name: 'Vendure Full E2E Shipper',
            phone: '+201000000001',
            country_code: 'EG',
            resolution_hash: SHIP_HASH,
            address_line: '12 Test Street Nasr City Cairo EG',
        },
        defaultServiceSlug: SERVICE_SLUG,
        shipmentCategory: 'dry',
        codEnabled: true,
        codFeeMode: 'absorb',
        isActive: true,
    });
    const tested = await connectionService.testConnection(ctx);
    assert.equal(tested.ok, true, `connection test failed: ${tested.message}`);

    // Product + variant
    const sku = 'BOLESA-E2E-SKU';
    let variantId: string | undefined;
    const existingVariants = await productVariantService.findAll(ctx, {
        filter: { sku: { eq: sku } },
    });
    if (existingVariants.items[0]) {
        variantId = String(existingVariants.items[0].id);
    } else {
        const product = await productService.create(ctx, {
            translations: [
                {
                    languageCode: LanguageCode.en,
                    name: 'Bolesa E2E Test Product',
                    slug: 'bolesa-e2e-test-product',
                    description: 'Synthetic product for local Partner E2E',
                },
            ],
            enabled: true,
        });
        const created = await productVariantService.create(ctx, [
            {
                productId: product.id,
                sku,
                price: 10_000, // 100.00 EGP minor
                taxCategoryId: taxCat.id,
                translations: [{ languageCode: LanguageCode.en, name: 'Bolesa E2E Variant' }],
                customFields: { weightKg: 1, bolesaCategory: 'dry' },
            },
        ] as any);
        const variant = Array.isArray(created) ? created[0] : created;
        variantId = String((variant as any).id);
    }
    assert.ok(variantId);

    // Channel + variant: no inventory gating for this synthetic SKU.
    await channelService.update(ctx, {
        id: channel!.id,
        trackInventory: false,
    } as any);
    await productVariantService.update(ctx, [
        {
            id: variantId,
            sku,
            enabled: true,
            trackInventory: GlobalFlag.FALSE,
        },
    ] as any);
    // Ensure variant is assigned to the E2E channel (create may have used default channel).
    await withPgClient(async client => {
        await client.query(
            `INSERT INTO product_variant_channels_channel ("productVariantId","channelId")
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [variantId, channel!.id],
        );
        await client.query(
            `INSERT INTO product_channels_channel ("productId","channelId")
             SELECT pv."productId", $2 FROM product_variant pv WHERE pv.id = $1
             ON CONFLICT DO NOTHING`,
            [variantId, channel!.id],
        );
        const locations = await stockLocationService.findAll(ctx);
        const loc = locations.items[0];
        if (loc) {
            await client.query(
                `INSERT INTO stock_level ("createdAt","updatedAt","stockOnHand","stockAllocated","productVariantId","stockLocationId")
                 VALUES (NOW(),NOW(),1000,0,$1,$2)
                 ON CONFLICT ("productVariantId","stockLocationId")
                 DO UPDATE SET "stockOnHand" = 1000, "updatedAt" = NOW()`,
                [variantId, loc.id],
            );
        }
        // Prefer the channel-assigned variant id if duplicates exist for the SKU.
        const preferred = await client.query<{ id: number }>(
            `SELECT pv.id FROM product_variant pv
             JOIN product_variant_channels_channel pvc ON pvc."productVariantId" = pv.id
             WHERE pv.sku = $1 AND pvc."channelId" = $2
             ORDER BY pv.id LIMIT 1`,
            [sku, channel!.id],
        );
        if (preferred.rows[0]) {
            variantId = String(preferred.rows[0].id);
            await client.query(
                `UPDATE product_variant SET "trackInventory" = 'FALSE', enabled = true WHERE id = $1`,
                [variantId],
            );
        }
    });

    // Shipping method
    const shipCode = 'bolesa-dom-e2e';
    let shippingMethodId: string;
    const shipMethods = await shippingMethodService.findAll(ctx);
    const existingShip = shipMethods.items.find(m => m.code === shipCode);
    if (existingShip) {
        shippingMethodId = String(existingShip.id);
    } else {
        const sm = await shippingMethodService.create(ctx, {
            code: shipCode,
            fulfillmentHandler: BOLESA_FULFILLMENT_HANDLER_CODE,
            checker: { code: BOLESA_ELIGIBILITY_CHECKER_CODE, arguments: [] },
            calculator: {
                code: BOLESA_SHIPPING_CALCULATOR_CODE,
                arguments: [
                    { name: 'carrierServiceSlug', value: SERVICE_SLUG },
                    { name: 'flatRateFallbackMinor', value: '0' },
                ],
            },
            translations: [
                {
                    languageCode: LanguageCode.en,
                    name: 'Bolesa Domestic E2E',
                    description: 'Live Bolesa rates',
                },
            ],
        });
        shippingMethodId = String(sm.id);
    }

    // Payment methods
    async function ensurePayment(
        code: string,
        handlerCode: string,
        name: string,
        args: Array<{ name: string; value: string }> = [],
    ): Promise<string> {
        const all = await paymentMethodService.findAll(ctx);
        const existing = all.items.find(p => p.code === code);
        if (existing) {
            return String(existing.id);
        }
        const pm = await paymentMethodService.create(ctx, {
            code,
            enabled: true,
            handler: { code: handlerCode, arguments: args },
            translations: [{ languageCode: LanguageCode.en, name, description: name }],
        });
        return String(pm.id);
    }
    const dummyPaymentMethodId = await ensurePayment(
        'dummy-prepaid-e2e',
        'dummy-payment-handler',
        'Dummy Prepaid E2E',
        [{ name: 'automaticSettle', value: 'true' }],
    );
    const codPaymentMethodId = await ensurePayment(
        'bolesa-cod-e2e',
        BOLESA_COD_HANDLER_CODE,
        'Bolesa COD E2E',
    );

    return {
        channelId: Number(channel.id),
        channelToken: channel.token,
        variantId,
        shippingMethodId,
        codPaymentMethodId,
        dummyPaymentMethodId,
    };
}

const FORBIDDEN_PARTNER_DATABASES = new Set([
    'vendure-dev',
    'vendure-bolesa-test',
    'postgres',
    'template0',
    'template1',
]);

/**
 * Local Partner app env used only to mark an AWB this harness created.
 * `BOLESA_LOCAL_PARTNER_ENV` wins. Otherwise the sibling checkout `bolesa-egy/.env`.
 */
export function localPartnerEnvPath(): string {
    const configured = process.env.BOLESA_LOCAL_PARTNER_ENV?.trim();
    const candidates = [
        configured,
        path.resolve(__dirname, '../../../../../../../../../bolesa-egy/.env'),
    ].filter((value): value is string => Boolean(value));
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) {
        throw new Error(
            `SAFETY ABORT: local Partner env file not found. Set BOLESA_LOCAL_PARTNER_ENV. Tried: ${candidates.join(', ')}`,
        );
    }
    return found;
}

function loadLocalPartnerDb(): {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
} {
    const lines = fs.readFileSync(localPartnerEnvPath(), 'utf8').split('\n');
    const env: Record<string, string> = {};
    for (const line of lines) {
        if (!line || line.startsWith('#') || !line.includes('=')) continue;
        const eq = line.indexOf('=');
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        // First wins for duplicated keys.
        if (!(key in env)) {
            env[key] = value;
        }
    }
    const host = env.DB_HOST || '127.0.0.1';
    const port = Number(env.DB_PORT || 5432);
    const database = env.DB_DATABASE;
    const user = env.DB_USERNAME;
    const password = env.DB_PASSWORD;
    if (!database || !user || !password || !Number.isFinite(port)) {
        throw new Error('SAFETY ABORT: local Partner env is missing database connection settings');
    }
    if (host !== '127.0.0.1' && host !== 'localhost') {
        throw new Error('SAFETY ABORT: local Partner database host is not local');
    }
    if (FORBIDDEN_PARTNER_DATABASES.has(database)) {
        throw new Error(`SAFETY ABORT: refusing to update AWB status in database ${database}`);
    }
    return { host, port, database, user, password };
}

/** Update one local Partner AWB status_code so reconcile can observe DELIVERED. */
export async function setLocalPartnerAwbStatus(
    trackingNumber: string,
    statusCode: string,
): Promise<void> {
    const db = loadLocalPartnerDb();
    const client = new pg.Client({
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
    });
    await client.connect();
    try {
        const current = String(
            (await client.query<{ current_database: string }>('SELECT current_database()')).rows[0]
                .current_database,
        );
        if (current !== db.database || FORBIDDEN_PARTNER_DATABASES.has(current)) {
            throw new Error(`SAFETY ABORT: connected to ${current}`);
        }
        const updated = await client.query(
            `UPDATE shipping_awbs
             SET status_code = $1,
                 is_delivered = $2,
                 updated_at = NOW()
             WHERE tracking_number = $3
             RETURNING id`,
            [statusCode, statusCode.toUpperCase() === 'DELIVERED', trackingNumber],
        );
        assert.equal(
            updated.rows.length,
            1,
            `expected 1 local AWB update for ${trackingNumber} in ${current}`,
        );
    } finally {
        await client.end();
    }
}

export function adminLoginMutation() {
    return `
      mutation ($u: String!, $p: String!) {
        login(username: $u, password: $p) {
          ... on CurrentUser { id }
          ... on ErrorResult { errorCode message }
        }
      }`;
}
