import { Inject, Injectable, Optional } from '@nestjs/common';
import { JsonCompatible } from '@vendure/common/lib/shared-types';
import {
    CacheService,
    ConfigService,
    Injector,
    Logger,
    Order,
    RequestContext,
} from '@vendure/core';

import { BOLESA_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import {
    BolesaPluginOptions,
    BolesaServiceChoice,
    BolesaServiceOption,
    PaymentPreference,
    PersistedBolesaQuote,
} from '../types';
import { majorToMinor, minorToMajor } from '../util/money';
import { merchantServiceSlugs } from '../util/merchant-services';
import { partnerAddressLine } from '../util/partner-address-line';
import { normalizeAccountServices } from '../util/service-rates';
import { normalizeServiceOffers } from '../util/service-offer';
import { mappedPricePresence, PricePresence } from '../util/shipping-diagnostics';
import { BolesaConnectionService } from './bolesa-connection.service';
import { BolesaClient, ServiceOptionPriceState } from './bolesa-client.service';

export interface BolesaCarrierChoice {
    slug: string;
    name: string;
    carrierPriceMinor: number;
    profitMinor: number;
    currencyCode: string;
}

export interface BolesaRateLookup {
    services: BolesaServiceOption[];
    httpStatus: number | null;
    cacheHit: boolean;
    /** Raw Partner presence. Empty when the lookup was served from cache. */
    rawPrices: ServiceOptionPriceState[];
    skipReason?: 'missing_resolution_hash';
}

@Injectable()
export class BolesaRateService {
    constructor(
        private connectionService: BolesaConnectionService,
        private client: BolesaClient,
        @Inject(BOLESA_PLUGIN_OPTIONS) private options: BolesaPluginOptions,
        @Optional() private cache?: CacheService,
        @Optional() private configService?: ConfigService,
    ) {}

    setCache(cache: CacheService) {
        this.cache = cache;
    }

    static orderFingerprint(
        order: Order,
        preference: PaymentPreference,
        channelCurrency = '',
        allowOpen = false,
    ): string {
        const addr = order.shippingAddress ?? {};
        const hash = (addr as any).customFields?.bolesaCityHash ?? '';
        const weight = order.lines.reduce((sum, l) => {
            const w = Number((l.productVariant as any).customFields?.weightKg ?? 0);
            return sum + w * l.quantity;
        }, 0);
        return [
            order.channels?.[0]?.id ?? '',
            hash,
            preference,
            weight.toFixed(3),
            order.subTotalWithTax,
            order.totalQuantity,
            channelCurrency.trim().toUpperCase(),
            allowOpen ? 'open' : 'closed',
        ].join('|');
    }

    async getOptionsForOrder(
        ctx: RequestContext,
        order: Order,
        preference: PaymentPreference,
    ): Promise<BolesaServiceOption[]> {
        const lookup = await this.lookupOptionsForOrder(ctx, order, preference);
        return lookup.services;
    }

    async lookupOptionsForOrder(
        ctx: RequestContext,
        order: Order,
        preference: PaymentPreference,
    ): Promise<BolesaRateLookup> {
        const conn = await this.connectionService.requireActive(ctx);
        const shipper = conn.shipperAddress;
        const consigneeHash = (order.shippingAddress as any)?.customFields?.bolesaCityHash;
        if (!shipper?.resolution_hash || !consigneeHash) {
            return {
                services: [],
                httpStatus: null,
                cacheHit: false,
                rawPrices: [],
                skipReason: 'missing_resolution_hash',
            };
        }

        const fingerprint = BolesaRateService.orderFingerprint(
            order,
            preference,
            ctx.channel.defaultCurrencyCode,
            conn.allowOpen === true,
        );
        const cacheKey = `bolesa:rates:${ctx.channelId}:${fingerprint}`;
        if (this.cache) {
            const cached = await this.cache.get<JsonCompatible<BolesaServiceOption[]>>(cacheKey);
            if (cached?.length) {
                return {
                    services: cached as BolesaServiceOption[],
                    httpStatus: null,
                    cacheHit: true,
                    rawPrices: [],
                };
            }
        }

        const weightKg = Math.max(
            0.01,
            order.lines.reduce((sum, l) => {
                const w = Number((l.productVariant as any).customFields?.weightKg ?? 1);
                return sum + w * l.quantity;
            }, 0),
        );

        const body: Record<string, unknown> = {
            shipment_type: 'domestic',
            shipment_operation: 'ship',
            shipment_category: conn.shipmentCategory ?? 'dry',
            payment_type: preference === 'cod' ? 'cod' : 'cc',
            weight: weightKg,
            allow_open: conn.allowOpen === true,
            shipper: {
                name: shipper.name,
                phone: shipper.phone,
                country_code: shipper.country_code ?? 'EG',
                resolution_hash: shipper.resolution_hash,
                address_line: partnerAddressLine(shipper.address_line),
            },
            consignees: [
                {
                    name: order.shippingAddress?.fullName ?? 'Customer',
                    phone: order.shippingAddress?.phoneNumber ?? '0000000000',
                    country_code: order.shippingAddress?.countryCode ?? 'EG',
                    resolution_hash: consigneeHash,
                    address_line: partnerAddressLine(
                        order.shippingAddress?.streetLine1,
                        order.shippingAddress?.streetLine2,
                        order.shippingAddress?.city,
                        order.shippingAddress?.province,
                    ),
                },
            ],
        };
        if (preference === 'cod') {
            // Goods + shipping estimated later; for options preview use goods total.
            body.cod_amount = minorToMajor(order.subTotalWithTax, this.moneyPrecision());
        }

        const auth = this.connectionService.authFor(conn);
        const observed = await this.client.observeServiceOptions(auth, body);
        // A 200 with only null prices is an upstream pricing failure, not a quote.
        // Caching it hides bolesa-shipping for the whole TTL after prices recover.
        // A real zero is finite and is cached.
        if (observed.services.some(serviceHasFinitePrice)) {
            if (this.cache) {
                await this.cache.set(cacheKey, observed.services as any[], {
                    ttl: this.options.rateCacheTtlMs ?? 600_000,
                });
            }
            await this.rememberReturnedRates(ctx, observed.services);
        }
        return {
            services: observed.services,
            httpStatus: observed.httpStatus,
            cacheHit: false,
            rawPrices: observed.rawPrices,
        };
    }

    /**
     * Carriers Partner can price for this order. Profit comes from the saved
     * service settings. The customer's charged shipping price is not changed.
     */
    async carrierChoicesForOrder(
        ctx: RequestContext,
        order: Order,
    ): Promise<{ paymentPreference: PaymentPreference; selectedSlug: string; choices: BolesaCarrierChoice[] }> {
        const raw = (order as any).customFields?.paymentPreference;
        const preference: PaymentPreference = raw === 'cod' ? 'cod' : 'prepaid';
        const conn = await this.connectionService.requireActive(ctx);
        const lookup = await this.lookupOptionsForOrder(ctx, order, preference);
        const enabled = new Set(merchantServiceSlugs(conn.enabledServiceSlugs));
        const offers = new Map(normalizeServiceOffers(conn.serviceOffers).map(offer => [offer.slug, offer]));
        const names = new Map(normalizeAccountServices(conn.accountServices).map(row => [row.slug, row.name]));
        const channel = ctx.channel.defaultCurrencyCode.trim().toUpperCase();
        const ranked: Array<BolesaCarrierChoice & { priority: number }> = [];
        for (const service of lookup.services) {
            if (!enabled.has(service.slug)) {
                continue;
            }
            const partner = service.currencyCode?.trim().toUpperCase();
            if (!partner || partner !== channel) {
                continue;
            }
            const major = preference === 'cod' ? service.codPrice : service.ccPrice;
            if (major == null || Number.isNaN(Number(major))) {
                continue;
            }
            const offer = offers.get(service.slug);
            ranked.push({
                slug: service.slug,
                name: names.get(service.slug) || service.label || service.carrierName || service.slug,
                carrierPriceMinor: majorToMinor(Number(major)),
                profitMinor: offer?.profitMinor ?? 0,
                currencyCode: partner,
                priority: offer?.priority ?? 100,
            });
        }
        ranked.sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
        return {
            paymentPreference: preference,
            selectedSlug: String((order as any).customFields?.bolesaServiceSlug ?? '').trim(),
            choices: ranked.map(({ priority: _priority, ...choice }) => choice),
        };
    }

    private async rememberReturnedRates(ctx: RequestContext, services: BolesaServiceOption[]): Promise<void> {
        if (typeof this.connectionService.rememberReturnedRates !== 'function') {
            return;
        }
        try {
            await this.connectionService.rememberReturnedRates(ctx, services);
        } catch (e: any) {
            Logger.warn(`Could not store returned carrier rates: ${e?.message}`, loggerCtx);
        }
    }

    pickOption(
        services: BolesaServiceOption[],
        serviceSlug: string | undefined,
    ): BolesaServiceOption | undefined {
        if (!services.length) {
            return undefined;
        }
        if (serviceSlug && serviceSlug !== 'auto') {
            return services.find(s => s.slug === serviceSlug);
        }
        return services[0];
    }

    /**
     * Every Partner service that has a real price. Unpriced rows are omitted.
     * A legitimate zero stays. Pricing uses {@link buildQuote}.
     */
    quoteChoices(
        services: BolesaServiceOption[],
        preference: PaymentPreference,
        markupPercent: number,
        codFeeMode: 'absorb' | 'passToCustomer',
        currencyCode: string,
    ): BolesaServiceChoice[] {
        const choices: BolesaServiceChoice[] = [];
        for (const option of services) {
            const built = this.buildQuote(option, preference, markupPercent, codFeeMode, currencyCode);
            if (!built) {
                continue;
            }
            const name = option.carrierName || option.label || option.slug;
            choices.push({
                slug: option.slug,
                name,
                label: option.label && option.label !== name ? option.label : undefined,
                logoUrl: option.logoUrl,
                priceMinor: built.priceMinor,
            });
        }
        return choices;
    }

    buildQuote(
        option: BolesaServiceOption,
        preference: PaymentPreference,
        markupPercent: number,
        codFeeMode: 'absorb' | 'passToCustomer',
        currencyCode: string,
    ): { priceMinor: number; quote: PersistedBolesaQuote } | undefined {
        const baseMajor =
            preference === 'cod'
                ? (option.codPrice ?? option.ccPrice)
                : (option.ccPrice ?? option.codPrice);
        if (baseMajor == null || Number.isNaN(baseMajor)) {
            return undefined;
        }
        const partnerCurrency = option.currencyCode?.trim().toUpperCase();
        const channelCurrency = currencyCode.trim().toUpperCase();
        // Partner amounts are major units of price.currency. Reusing the number
        // under a different channel currency (for example SAR shown as USD) is not a conversion.
        if (!partnerCurrency || partnerCurrency !== channelCurrency) {
            return undefined;
        }
        let major = Number(baseMajor);
        if (preference === 'cod' && codFeeMode === 'passToCustomer' && option.codCollectionFee) {
            major += Number(option.codCollectionFee);
        }
        if (markupPercent) {
            major = major * (1 + markupPercent / 100);
        }
        const priceMinor = majorToMinor(major, this.moneyPrecision());
        const carrierPriceMinor = majorToMinor(Number(baseMajor), this.moneyPrecision());
        const quote: PersistedBolesaQuote = {
            serviceSlug: option.slug,
            carrierName: option.carrierName,
            priceMinor,
            carrierPriceMinor,
            profitMinor: Math.max(0, priceMinor - carrierPriceMinor),
            currencyCode: partnerCurrency,
            codFeeMinor:
                option.codCollectionFee != null
                    ? majorToMinor(option.codCollectionFee, this.moneyPrecision())
                    : undefined,
            paymentPreference: preference,
            capturedAt: new Date().toISOString(),
        };
        return { priceMinor, quote };
    }

    priceStateFor(
        lookup: BolesaRateLookup,
        option: BolesaServiceOption | undefined,
    ): { ccPrice: PricePresence; codPrice: PricePresence } {
        if (!option) {
            return { ccPrice: 'undefined', codPrice: 'undefined' };
        }
        const raw = lookup.rawPrices.find(row => row.slug === option.slug);
        if (raw) {
            return { ccPrice: raw.ccPrice, codPrice: raw.codPrice };
        }
        return {
            ccPrice: mappedPricePresence(option.ccPrice),
            codPrice: mappedPricePresence(option.codPrice),
        };
    }

    private moneyPrecision(): number {
        const precision = this.configService?.entityOptions?.moneyStrategy?.precision;
        return typeof precision === 'number' ? precision : 2;
    }

    /**
     * Shop API ShippingMethodQuote.metadata.
     * Carrier name and service slug stay off this object. The customer sees the price only.
     */
    publicMetadata(quote: PersistedBolesaQuote) {
        return {
            carrierPriceMinor: quote.carrierPriceMinor,
            profitMinor: quote.profitMinor,
        };
    }
}

/** Shopper choice wins. Otherwise the shipping-method slug, including `auto`. */
export function resolveCarrierSlug(selected: unknown, configured: string | undefined): string {
    if (typeof selected === 'string' && selected.trim()) {
        return selected.trim();
    }
    const fallback = configured?.trim();
    return fallback || 'auto';
}

function serviceHasFinitePrice(option: BolesaServiceOption): boolean {
    return Number.isFinite(option.ccPrice) || Number.isFinite(option.codPrice);
}

/** Late-bind CacheService into rate service from ShippingCalculator.init */
export function bindRateCache(injector: Injector, rateService: BolesaRateService) {
    try {
        rateService.setCache(injector.get(CacheService));
    } catch (e: any) {
        Logger.warn(`Could not bind CacheService: ${e?.message}`, loggerCtx);
    }
}
