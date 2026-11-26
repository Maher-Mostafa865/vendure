import type { INestApplicationContext } from '@nestjs/common';
import {
    Channel,
    ChannelService,
    Collection,
    CountryService,
    CurrencyCode,
    Facet,
    ID,
    isGraphQlErrorResult,
    LanguageCode,
    Logger,
    PaymentMethod,
    PaymentMethodService,
    Product,
    RequestContext,
    RequestContextService,
    ShippingMethod,
    ShippingMethodService,
    TransactionalConnection,
    ZoneService,
} from '@vendure/core';

import {
    BOLESA_COD_HANDLER_CODE,
    BOLESA_ELIGIBILITY_CHECKER_CODE,
    BOLESA_FULFILLMENT_HANDLER_CODE,
    BOLESA_SHIPPING_CALCULATOR_CODE,
} from '../plugins/bolesa/constants';
import { BolesaConnectionService } from '../plugins/bolesa/services/bolesa-connection.service';
import { PAYMOB_ELIGIBILITY_CHECKER_CODE, PAYMOB_HANDLER_CODE } from '../plugins/paymob/constants';
import { PaymobConnectionService } from '../plugins/paymob/services/paymob-connection.service';

const loggerCtx = 'SeedMarkets';

/** ElHay 06 (Nasr City) — known local Partner hash for EG shipper. */
const EG_SHIPPER_HASH = '4c2279956e07a68e2eacaeb97382d3e5';

/** Storefront / checkout payment + shipping method codes. */
export const COD_PAYMENT_METHOD_CODE = 'bolesa-cod';
export const PAYMOB_PAYMENT_METHOD_CODE = 'paymob';
export const BOLESA_SHIPPING_METHOD_CODE = 'bolesa-shipping';

export const SAUDI_CHANNEL_CODE = 'saudi-arabia';
export const SAUDI_CHANNEL_TOKEN = 'saudi-arabia-channel';

function env(name: string, fallback = ''): string {
    return String(process.env[name] ?? fallback).trim();
}

function requireEnv(name: string): string {
    const value = env(name);
    if (!value) {
        throw new Error(`Missing required env ${name} for market seeder`);
    }
    return value;
}

/** 0112… → +20112… for EG local numbers. */
export function normalizeEgPhone(phone: string): string {
    const raw = phone.trim();
    if (raw.startsWith('+')) {
        return raw;
    }
    if (raw.startsWith('00')) {
        return `+${raw.slice(2)}`;
    }
    if (raw.startsWith('0')) {
        return `+20${raw.slice(1)}`;
    }
    return raw;
}

async function ensureCountry(
    ctx: RequestContext,
    countryService: CountryService,
    code: string,
    name: string,
) {
    const all = await countryService.findAll(ctx, { take: 500 });
    const existing = all.items.find(c => c.code === code);
    if (existing) {
        return existing;
    }
    return countryService.create(ctx, {
        code,
        enabled: true,
        translations: [{ languageCode: LanguageCode.en, name }],
    });
}

async function ensureZoneWithCountry(
    ctx: RequestContext,
    zoneService: ZoneService,
    zoneName: string,
    countryId: ID,
) {
    const zones = await zoneService.getAllWithMembers(ctx);
    let zone = zones.find(z => z.name === zoneName);
    if (!zone) {
        zone = await zoneService.create(ctx, { name: zoneName });
    }
    const memberIds = (zone.members ?? []).map(m => String(m.id));
    if (!memberIds.includes(String(countryId))) {
        zone = await zoneService.addMembersToZone(ctx, {
            zoneId: zone.id,
            memberIds: [countryId],
        });
    }
    return zone;
}

async function assignCatalogToChannel(
    ctx: RequestContext,
    channelService: ChannelService,
    connection: TransactionalConnection,
    channelId: ID,
): Promise<void> {
    const defaultIds = [ctx.channelId, channelId];
    const assignAll = async <T extends Product | Collection | Facet | ShippingMethod | PaymentMethod>(
        Entity: new (...args: any[]) => T,
    ) => {
        const rows = await connection.getRepository(ctx, Entity as any).find({
            select: ['id'],
            take: 5000,
        });
        for (const row of rows) {
            await channelService.assignToChannels(ctx, Entity as any, row.id, defaultIds);
        }
    };
    await assignAll(Product);
    await assignAll(Collection);
    await assignAll(Facet);
    await assignAll(ShippingMethod);
    await assignAll(PaymentMethod);
}

async function seedEgyptDefaultChannel(
    app: INestApplicationContext,
    ctx: RequestContext,
): Promise<Channel> {
    const channelService = app.get(ChannelService);
    const countryService = app.get(CountryService);
    const zoneService = app.get(ZoneService);

    const eg = await ensureCountry(ctx, countryService, 'EG', 'Egypt');
    const africa = await ensureZoneWithCountry(ctx, zoneService, 'Africa', eg.id);

    const updated = await channelService.update(ctx, {
        id: ctx.channelId,
        defaultLanguageCode: LanguageCode.en,
        availableLanguageCodes: [LanguageCode.en],
        defaultCurrencyCode: CurrencyCode.EGP,
        // Egypt channel is EGP-only so the storefront cannot keep a USD cart by mistake.
        availableCurrencyCodes: [CurrencyCode.EGP],
        pricesIncludeTax: false,
        defaultTaxZoneId: africa.id,
        defaultShippingZoneId: africa.id,
        customFields: { marketCountry: 'EG' },
    } as any);
    if (isGraphQlErrorResult(updated)) {
        throw new Error(`Failed to update default channel: ${updated.message}`);
    }
    Logger.info('Default channel → Egypt (EGP, marketCountry=EG, zone=Africa)', loggerCtx);
    return updated as Channel;
}

async function seedSaudiChannel(app: INestApplicationContext, ctx: RequestContext): Promise<Channel> {
    const channelService = app.get(ChannelService);
    const countryService = app.get(CountryService);
    const zoneService = app.get(ZoneService);

    const sa = await ensureCountry(ctx, countryService, 'SA', 'Saudi Arabia');
    const middleEast = await ensureZoneWithCountry(ctx, zoneService, 'Middle East', sa.id);

    const existing = (await channelService.findAll(ctx)).items.find(c => c.code === SAUDI_CHANNEL_CODE);
    if (existing) {
        const updated = await channelService.update(ctx, {
            id: existing.id,
            defaultCurrencyCode: CurrencyCode.SAR,
            availableCurrencyCodes: [CurrencyCode.SAR],
            defaultTaxZoneId: middleEast.id,
            defaultShippingZoneId: middleEast.id,
            customFields: { marketCountry: 'SA' },
        } as any);
        if (isGraphQlErrorResult(updated)) {
            throw new Error(`Failed to update Saudi channel: ${updated.message}`);
        }
        Logger.info('Saudi channel already exists — refreshed currency/zones', loggerCtx);
        return updated as Channel;
    }

    const created = await channelService.create(ctx, {
        code: SAUDI_CHANNEL_CODE,
        token: SAUDI_CHANNEL_TOKEN,
        defaultLanguageCode: LanguageCode.en,
        availableLanguageCodes: [LanguageCode.en],
        defaultCurrencyCode: CurrencyCode.SAR,
        availableCurrencyCodes: [CurrencyCode.SAR],
        pricesIncludeTax: false,
        defaultTaxZoneId: middleEast.id,
        defaultShippingZoneId: middleEast.id,
        customFields: { marketCountry: 'SA' },
    } as any);
    if (isGraphQlErrorResult(created)) {
        throw new Error(`Failed to create Saudi channel: ${created.message}`);
    }
    Logger.info(`Created Saudi channel code=${SAUDI_CHANNEL_CODE} token=${SAUDI_CHANNEL_TOKEN}`, loggerCtx);
    return created as Channel;
}

async function seedBolesaEgypt(app: INestApplicationContext, ctx: RequestContext): Promise<void> {
    const connectionService = app.get(BolesaConnectionService);
    const apiBaseUrl = env('BOLESA_API_BASE_URL', 'http://127.0.0.1:8000/api/pcl/v1');
    const token = env('BOLESA_EG_PARTNER_TOKEN') || env('BOLESA_PARTNER_TOKEN');
    if (!token) {
        Logger.warn('Skip EG Bolesa connection — set BOLESA_EG_PARTNER_TOKEN or BOLESA_PARTNER_TOKEN', loggerCtx);
        return;
    }

    const shipperName = env('BOLESA_EG_SHIPPER_NAME', 'test shipper bolesa');
    const shipperPhone = normalizeEgPhone(env('BOLESA_EG_SHIPPER_PHONE', '01128783650'));
    const resolutionHash = env('BOLESA_EG_SHIPPER_HASH', EG_SHIPPER_HASH);
    const addressLine = env(
        'BOLESA_EG_SHIPPER_ADDRESS',
        '32 Nagaty El-Sarag St., Nasr City - El Serag Mall, Cairo, Egypt',
    );

    await connectionService.upsert(ctx, {
        apiBaseUrl,
        token,
        shipperAddress: {
            name: shipperName,
            phone: shipperPhone,
            country_code: 'EG',
            resolution_hash: resolutionHash,
            address_line: addressLine,
        },
        shipmentCategory: 'dry',
        codEnabled: true,
        codFeeMode: 'absorb',
        isActive: true,
    });

    try {
        const tested = await connectionService.testConnection(ctx);
        Logger.info(`EG Bolesa test: ${tested.ok ? 'ok' : tested.message}`, loggerCtx);
    } catch (e: any) {
        Logger.warn(`EG Bolesa saved but test failed: ${e?.message ?? e}`, loggerCtx);
    }
}

async function seedBolesaSaudi(app: INestApplicationContext, ctx: RequestContext): Promise<void> {
    const connectionService = app.get(BolesaConnectionService);
    const apiBaseUrl = env('BOLESA_SA_API_BASE_URL') || env('BOLESA_API_BASE_URL', 'http://127.0.0.1:8000/api/pcl/v1');
    const token = env('BOLESA_SA_PARTNER_TOKEN');
    if (!token) {
        Logger.warn('Skip SA Bolesa connection — set BOLESA_SA_PARTNER_TOKEN when ready', loggerCtx);
        return;
    }

    await connectionService.upsert(ctx, {
        apiBaseUrl,
        token,
        shipperAddress: {
            name: env('BOLESA_SA_SHIPPER_NAME', 'test shipper bolesa SA'),
            phone: env('BOLESA_SA_SHIPPER_PHONE', '+966500000000'),
            country_code: 'SA',
            resolution_hash: env('BOLESA_SA_SHIPPER_HASH', ''),
            address_line: env('BOLESA_SA_SHIPPER_ADDRESS', 'Riyadh, Saudi Arabia'),
        },
        shipmentCategory: 'dry',
        codEnabled: true,
        isActive: true,
    });
    Logger.info('SA Bolesa connection upserted', loggerCtx);
}

function readPaymobEnv(prefix: '' | 'SA_'): {
    apiKey: string;
    secretKey: string;
    publicKey: string;
    hmacSecret: string;
    baseUrl: string;
} | null {
    const apiKey = env(prefix ? `PAYMOB_${prefix}API_KEY` : 'PAYMOB_API_KEY');
    const secretKey = env(prefix ? `PAYMOB_${prefix}SECRET_KEY` : 'PAYMOB_SECRET_KEY');
    const publicKey = env(prefix ? `PAYMOB_${prefix}PUBLIC_KEY` : 'PAYMOB_PUBLIC_KEY');
    const hmacSecret = env(prefix ? `PAYMOB_${prefix}HMAC_SECRET` : 'PAYMOB_HMAC_SECRET');
    if (!apiKey || !secretKey || !publicKey || !hmacSecret) {
        return null;
    }
    return {
        apiKey,
        secretKey,
        publicKey,
        hmacSecret,
        baseUrl: env(
            prefix ? `PAYMOB_${prefix}BASE_URL` : 'PAYMOB_BASE_URL',
            'https://accept.paymob.com',
        ),
    };
}

async function seedPaymobEgypt(app: INestApplicationContext, ctx: RequestContext): Promise<void> {
    const paymob = app.get(PaymobConnectionService);
    const creds = readPaymobEnv('');
    if (!creds) {
        Logger.warn(
            'Skip EG Paymob — set PAYMOB_API_KEY, PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY, PAYMOB_HMAC_SECRET',
            loggerCtx,
        );
        return;
    }

    const egp = env('PAYMOB_INTEGRATION_ID_EGP') || env('PAYMOB_INTEGRATION_ID');
    await paymob.upsert(ctx, {
        mode: 'test',
        isActive: true,
        marketCountry: 'EG',
        testCredentials: {
            baseUrl: creds.baseUrl,
            apiKey: creds.apiKey,
            secretKey: creds.secretKey,
            publicKey: creds.publicKey,
            hmacSecret: creds.hmacSecret,
            integrationIdsByCurrency: {
                EGP: egp,
                USD: env('PAYMOB_INTEGRATION_ID_USD'),
                SAR: env('PAYMOB_INTEGRATION_ID_SAR'),
                EUR: env('PAYMOB_INTEGRATION_ID_EUR'),
            },
        },
    });
    Logger.info('EG Paymob test credentials upserted', loggerCtx);
}

async function seedPaymobSaudi(app: INestApplicationContext, ctx: RequestContext): Promise<void> {
    const paymob = app.get(PaymobConnectionService);
    const saCreds = readPaymobEnv('SA_');
    const egCreds = readPaymobEnv('');
    const creds = saCreds ?? egCreds;
    if (!creds) {
        Logger.warn('Skip SA Paymob — set PAYMOB_SA_* or EG PAYMOB_* credentials', loggerCtx);
        await paymob.updateChannelMarketCountry(ctx, 'SA');
        return;
    }
    if (!saCreds && egCreds) {
        Logger.warn(
            'SA Paymob using EG PAYMOB_* credentials (set PAYMOB_SA_* for a dedicated SA account)',
            loggerCtx,
        );
    }

    await paymob.upsert(ctx, {
        mode: 'test',
        isActive: true,
        marketCountry: 'SA',
        testCredentials: {
            baseUrl: creds.baseUrl,
            apiKey: creds.apiKey,
            secretKey: creds.secretKey,
            publicKey: creds.publicKey,
            hmacSecret: creds.hmacSecret,
            integrationIdsByCurrency: {
                SAR:
                    env('PAYMOB_SA_INTEGRATION_ID_SAR') ||
                    env('PAYMOB_INTEGRATION_ID_SAR') ||
                    env('PAYMOB_INTEGRATION_ID_EGP') ||
                    env('PAYMOB_INTEGRATION_ID'),
                USD: env('PAYMOB_SA_INTEGRATION_ID_USD') || env('PAYMOB_INTEGRATION_ID_USD'),
                EGP: env('PAYMOB_INTEGRATION_ID_EGP') || env('PAYMOB_INTEGRATION_ID'),
            },
        },
    });
    Logger.info('SA Paymob test credentials upserted', loggerCtx);
}

/**
 * Ensure COD + Paymob payment methods and Bolesa shipping exist on every market channel.
 * Disables the stock `standard-payment` dummy so checkout only offers real methods.
 */
async function seedCheckoutMethods(
    app: INestApplicationContext,
    ctx: RequestContext,
    channelIds: ID[],
): Promise<void> {
    const paymentMethodService = app.get(PaymentMethodService);
    const shippingMethodService = app.get(ShippingMethodService);
    const channelService = app.get(ChannelService);

    const ensurePayment = async (input: {
        code: string;
        name: string;
        description: string;
        handlerCode: string;
        checkerCode: string;
        checkerArgs?: Array<{ name: string; value: string }>;
    }) => {
        const all = await paymentMethodService.findAll(ctx, { take: 100 });
        const existing = all.items.find(p => p.code === input.code);
        let id: ID;
        if (existing) {
            const updated = await paymentMethodService.update(ctx, {
                id: existing.id,
                enabled: true,
                handler: { code: input.handlerCode, arguments: [] },
                checker: {
                    code: input.checkerCode,
                    arguments: input.checkerArgs ?? [],
                },
                translations: [
                    {
                        languageCode: LanguageCode.en,
                        name: input.name,
                        description: input.description,
                    },
                ],
            });
            id = updated.id;
        } else {
            const created = await paymentMethodService.create(ctx, {
                code: input.code,
                enabled: true,
                handler: { code: input.handlerCode, arguments: [] },
                checker: {
                    code: input.checkerCode,
                    arguments: input.checkerArgs ?? [],
                },
                translations: [
                    {
                        languageCode: LanguageCode.en,
                        name: input.name,
                        description: input.description,
                    },
                ],
            });
            id = created.id;
        }
        await channelService.assignToChannels(ctx, PaymentMethod, id, channelIds);
        return id;
    };

    await ensurePayment({
        code: COD_PAYMENT_METHOD_CODE,
        name: 'Cash on delivery',
        description: 'Pay the courier when your order arrives.',
        handlerCode: BOLESA_COD_HANDLER_CODE,
        checkerCode: 'bolesa-cod-eligibility',
        checkerArgs: [{ name: 'orderMinimum', value: '0' }],
    });
    await ensurePayment({
        code: PAYMOB_PAYMENT_METHOD_CODE,
        name: 'Pay with card (Paymob)',
        description: 'Pay securely by card via Paymob.',
        handlerCode: PAYMOB_HANDLER_CODE,
        checkerCode: PAYMOB_ELIGIBILITY_CHECKER_CODE,
    });

    const allPayments = await paymentMethodService.findAll(ctx, { take: 100 });
    for (const method of allPayments.items) {
        if (method.code === 'standard-payment' && method.enabled) {
            await paymentMethodService.update(ctx, { id: method.id, enabled: false });
            Logger.info(`Disabled dummy payment method id=${method.id}`, loggerCtx);
        }
    }

    const shipMethods = await shippingMethodService.findAll(ctx, { take: 100 });
    const existingShip = shipMethods.items.find(m => m.code === BOLESA_SHIPPING_METHOD_CODE);
    let shippingId: ID;
    if (existingShip) {
        const updated = await shippingMethodService.update(ctx, {
            id: existingShip.id,
            fulfillmentHandler: BOLESA_FULFILLMENT_HANDLER_CODE,
            checker: { code: BOLESA_ELIGIBILITY_CHECKER_CODE, arguments: [] },
            calculator: { code: BOLESA_SHIPPING_CALCULATOR_CODE, arguments: [] },
            translations: [
                {
                    languageCode: LanguageCode.en,
                    name: 'Standard shipping',
                    description: 'Live Bolesa carrier rates',
                },
            ],
        });
        shippingId = updated.id;
    } else {
        const created = await shippingMethodService.create(ctx, {
            code: BOLESA_SHIPPING_METHOD_CODE,
            fulfillmentHandler: BOLESA_FULFILLMENT_HANDLER_CODE,
            checker: { code: BOLESA_ELIGIBILITY_CHECKER_CODE, arguments: [] },
            calculator: { code: BOLESA_SHIPPING_CALCULATOR_CODE, arguments: [] },
            translations: [
                {
                    languageCode: LanguageCode.en,
                    name: 'Standard shipping',
                    description: 'Live Bolesa carrier rates',
                },
            ],
        });
        shippingId = created.id;
    }
    await channelService.assignToChannels(ctx, ShippingMethod, shippingId, channelIds);

    Logger.info(
        `Checkout methods ready on ${channelIds.length} channel(s): ${COD_PAYMENT_METHOD_CODE}, ${PAYMOB_PAYMENT_METHOD_CODE}, ${BOLESA_SHIPPING_METHOD_CODE}`,
        loggerCtx,
    );
}

/**
 * Idempotent market bootstrap:
 * - Default channel → Egypt (EGP + marketCountry EG + Bolesa/Paymob)
 * - Saudi channel → SAR + marketCountry SA (+ optional Bolesa/Paymob from env)
 * - COD + Paymob payment methods and Bolesa shipping on both channels
 */
export async function seedMarkets(app: INestApplicationContext): Promise<{
    egyptChannelToken: string;
    saudiChannelToken: string;
}> {
    const requestContextService = app.get(RequestContextService);
    const channelService = app.get(ChannelService);
    const connection = app.get(TransactionalConnection);

    const ctx = await requestContextService.create({ apiType: 'admin' });

    const egyptChannel = await seedEgyptDefaultChannel(app, ctx);
    await seedBolesaEgypt(app, ctx);
    await seedPaymobEgypt(app, ctx);

    const saudiChannel = await seedSaudiChannel(app, ctx);
    await assignCatalogToChannel(ctx, channelService, connection, saudiChannel.id);

    const saudiCtx = await requestContextService.create({
        apiType: 'admin',
        channelOrToken: saudiChannel,
    });
    await seedBolesaSaudi(app, saudiCtx);
    await seedPaymobSaudi(app, saudiCtx);

    await seedCheckoutMethods(app, ctx, [egyptChannel.id, saudiChannel.id]);

    Logger.info(
        `Markets ready. EG token=${egyptChannel.token} SA token=${saudiChannel.token}`,
        loggerCtx,
    );
    return {
        egyptChannelToken: egyptChannel.token,
        saudiChannelToken: saudiChannel.token,
    };
}
