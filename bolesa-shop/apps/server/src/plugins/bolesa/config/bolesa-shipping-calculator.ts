import { LanguageCode, Logger, ShippingCalculator } from '@vendure/core';

import { BOLESA_SHIPPING_CALCULATOR_CODE, loggerCtx } from '../constants';
import { BolesaApiError } from '../services/bolesa-client.service';
import { BolesaConnectionService } from '../services/bolesa-connection.service';
import { bindRateCache, BolesaRateService } from '../services/bolesa-rate.service';
import { merchantServiceSlugs } from '../util/merchant-services';
import { PaymentPreference } from '../types';
import { PricePresence } from '../util/shipping-diagnostics';
import { normalizeServiceOffers, quoteCustomerShipping } from '../util/service-offer';

export interface ShippingCalculationLog {
    executed: true;
    cacheHit: boolean;
    httpStatus: number | null;
    serviceCount: number;
    ccPrice: PricePresence;
    codPrice: PricePresence;
    outcome: 'price' | 'undefined';
    reason:
        | 'quoted'
        | 'missing_price'
        | 'currency_unknown'
        | 'currency_mismatch'
        | 'no_services'
        | 'slug_not_found'
        | 'service_not_enabled'
        | 'missing_resolution_hash'
        | 'partner_http_error';
    /** Minor units when outcome is price. Null when the method is omitted. Never 0 for a Partner error. */
    priceMinor: number | null;
    /** Order custom field bolesaQuote is written on OrderPlaced, not during eligibleShippingMethods. */
    quotePersisted: false;
}

let rateService: BolesaRateService;
let connectionService: BolesaConnectionService;

export const bolesaShippingCalculator = new ShippingCalculator({
    code: BOLESA_SHIPPING_CALCULATOR_CODE,
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Shipping price from Bolesa Connection: the live carrier rate plus your profit',
        },
        {
            languageCode: LanguageCode.ar,
            value: 'سعر الشحن من صفحة Bolesa Connection: سعر شركة الشحن بالإضافة إلى المكسب',
        },
    ],
    args: {},
    init(injector) {
        rateService = injector.get(BolesaRateService);
        connectionService = injector.get(BolesaConnectionService);
        bindRateCache(injector, rateService);
    },
    calculate: async (ctx, order) => {
        const preference = ((order as any).customFields?.paymentPreference ?? 'prepaid') as PaymentPreference;
        try {
            const conn = await connectionService.requireActive(ctx);
            const lookup = await rateService.lookupOptionsForOrder(ctx, order, preference);
            const enabled = merchantServiceSlugs(conn.enabledServiceSlugs);
            const quoted = quoteCustomerShipping({
                services: lookup.services,
                enabledSlugs: enabled,
                offers: normalizeServiceOffers(conn.serviceOffers),
                preference,
                currencyCode: ctx.channel.defaultCurrencyCode,
            });
            const option = quoted
                ? lookup.services.find(service => service.slug === quoted.slug)
                : undefined;
            const prices = rateService.priceStateFor(lookup, option);
            if (!quoted) {
                const offered = lookup.services.filter(service => enabled.includes(service.slug));
                logCalculation({
                    executed: true,
                    cacheHit: lookup.cacheHit,
                    httpStatus: lookup.httpStatus,
                    serviceCount: lookup.services.length,
                    ccPrice: prices.ccPrice,
                    codPrice: prices.codPrice,
                    outcome: 'undefined',
                    reason: lookup.skipReason === 'missing_resolution_hash'
                        ? 'missing_resolution_hash'
                        : !enabled.length
                          ? 'service_not_enabled'
                          : !offered.length
                            ? lookup.services.length
                              ? 'service_not_enabled'
                              : 'no_services'
                            : currencyBlockReason(offered, ctx.channel.defaultCurrencyCode) ??
                              'missing_price',
                    priceMinor: null,
                    quotePersisted: false,
                });
                return undefined;
            }
            logCalculation({
                executed: true,
                cacheHit: lookup.cacheHit,
                httpStatus: lookup.httpStatus,
                serviceCount: lookup.services.length,
                ccPrice: prices.ccPrice,
                codPrice: prices.codPrice,
                outcome: 'price',
                reason: 'quoted',
                priceMinor: quoted.customerPriceMinor,
                quotePersisted: false,
            });
            return {
                price: quoted.customerPriceMinor,
                // The customer price already includes the store profit. Do not add tax again.
                priceIncludesTax: true,
                taxRate: 0,
                metadata: {},
            };
        } catch (e: any) {
            const httpStatus = e instanceof BolesaApiError ? e.status : null;
            logCalculation({
                executed: true,
                cacheHit: false,
                httpStatus,
                serviceCount: 0,
                ccPrice: 'undefined',
                codPrice: 'undefined',
                outcome: 'undefined',
                reason: 'partner_http_error',
                priceMinor: null,
                quotePersisted: false,
            });
            return undefined;
        }
    },
});

/**
 * A priced Partner row that cannot be charged in the channel currency.
 * Missing prices stay `missing_price` so a null quote is not reported as a currency error.
 */
function currencyBlockReason(
    services: Array<{ ccPrice?: number; codPrice?: number; currencyCode?: string }>,
    channelCurrency: string,
): 'currency_unknown' | 'currency_mismatch' | undefined {
    const priced = services.filter(
        service =>
            (service.ccPrice != null && !Number.isNaN(service.ccPrice)) ||
            (service.codPrice != null && !Number.isNaN(service.codPrice)),
    );
    if (!priced.length) {
        return undefined;
    }
    const partner = priced[0].currencyCode?.trim().toUpperCase();
    const channel = channelCurrency.trim().toUpperCase();
    if (!partner) {
        return 'currency_unknown';
    }
    if (partner !== channel) {
        return 'currency_mismatch';
    }
    return undefined;
}

function logCalculation(entry: ShippingCalculationLog): void {
    const line = `bolesa.shipping.calculate ${JSON.stringify(entry)}`;
    if (entry.outcome === 'price' && entry.reason === 'quoted') {
        Logger.info(line, loggerCtx);
    } else {
        Logger.warn(line, loggerCtx);
    }
}
