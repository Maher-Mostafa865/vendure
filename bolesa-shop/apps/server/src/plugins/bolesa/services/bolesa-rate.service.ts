import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    CacheService,
    Injector,
    Logger,
    Order,
    RequestContext,
} from '@vendure/core';

import { BOLESA_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { BolesaPluginOptions, BolesaServiceOption, PaymentPreference, PersistedBolesaQuote } from '../types';
import { majorToMinor, minorToMajor } from '../util/money';
import { BolesaConnectionService } from './bolesa-connection.service';
import { BolesaClient } from './bolesa-client.service';

@Injectable()
export class BolesaRateService {
    constructor(
        private connectionService: BolesaConnectionService,
        private client: BolesaClient,
        @Inject(BOLESA_PLUGIN_OPTIONS) private options: BolesaPluginOptions,
        @Optional() private cache?: CacheService,
    ) {}

    setCache(cache: CacheService) {
        this.cache = cache;
    }

    static orderFingerprint(order: Order, preference: PaymentPreference): string {
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
        ].join('|');
    }

    async getOptionsForOrder(
        ctx: RequestContext,
        order: Order,
        preference: PaymentPreference,
    ): Promise<BolesaServiceOption[]> {
        const conn = await this.connectionService.requireActive(ctx);
        const shipper = conn.shipperAddress;
        const consigneeHash = (order.shippingAddress as any)?.customFields?.bolesaCityHash;
        if (!shipper?.resolution_hash || !consigneeHash) {
            return [];
        }

        const fingerprint = BolesaRateService.orderFingerprint(order, preference);
        const cacheKey = `bolesa:rates:${ctx.channelId}:${fingerprint}`;
        if (this.cache) {
            const cached = await this.cache.get<any[]>(cacheKey);
            if (cached?.length) {
                return cached as BolesaServiceOption[];
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
            shipper: {
                name: shipper.name,
                phone: shipper.phone,
                country_code: shipper.country_code ?? 'EG',
                resolution_hash: shipper.resolution_hash,
                address_line: shipper.address_line,
            },
            consignees: [
                {
                    name: order.shippingAddress?.fullName ?? 'Customer',
                    phone: order.shippingAddress?.phoneNumber ?? '0000000000',
                    country_code: order.shippingAddress?.countryCode ?? 'EG',
                    resolution_hash: consigneeHash,
                    address_line:
                        [order.shippingAddress?.streetLine1, order.shippingAddress?.streetLine2]
                            .filter(Boolean)
                            .join(', ') || 'Address',
                },
            ],
        };
        if (preference === 'cod') {
            // Goods + shipping estimated later; for options preview use goods total.
            body.cod_amount = minorToMajor(order.subTotalWithTax);
        }

        const auth = this.connectionService.authFor(conn);
        const services = await this.client.serviceOptions(auth, body);
        if (this.cache) {
            await this.cache.set(cacheKey, services as any[], {
                ttl: this.options.rateCacheTtlMs ?? 600_000,
            });
        }
        return services;
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
        let major = Number(baseMajor);
        if (preference === 'cod' && codFeeMode === 'passToCustomer' && option.codCollectionFee) {
            major += Number(option.codCollectionFee);
        }
        if (markupPercent) {
            major = major * (1 + markupPercent / 100);
        }
        const priceMinor = majorToMinor(major);
        const quote: PersistedBolesaQuote = {
            serviceSlug: option.slug,
            carrierName: option.carrierName,
            priceMinor,
            currencyCode,
            codFeeMinor: option.codCollectionFee != null ? majorToMinor(option.codCollectionFee) : undefined,
            paymentPreference: preference,
            capturedAt: new Date().toISOString(),
        };
        return { priceMinor, quote };
    }

    /** Whitelist for Shop API ShippingMethodQuote.metadata — never include contracts/fees breakdown. */
    publicMetadata(quote: PersistedBolesaQuote) {
        return {
            serviceSlug: quote.serviceSlug,
            carrierName: quote.carrierName,
        };
    }
}

/** Late-bind CacheService into rate service from ShippingCalculator.init */
export function bindRateCache(injector: Injector, rateService: BolesaRateService) {
    try {
        rateService.setCache(injector.get(CacheService));
    } catch (e: any) {
        Logger.warn(`Could not bind CacheService: ${e?.message}`, loggerCtx);
    }
}
