import { LanguageCode, Logger, ShippingCalculator } from '@vendure/core';

import { BOLESA_SHIPPING_CALCULATOR_CODE, loggerCtx } from '../constants';
import { BolesaApiError } from '../services/bolesa-client.service';
import { BolesaConnectionService } from '../services/bolesa-connection.service';
import { bindRateCache, BolesaRateService } from '../services/bolesa-rate.service';
import { PaymentPreference } from '../types';
import { PricePresence } from '../util/shipping-diagnostics';

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
        | 'no_services'
        | 'slug_not_found'
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
    description: [{ languageCode: LanguageCode.en, value: 'Live Bolesa Partner API rates' }],
    args: {
        carrierServiceSlug: {
            type: 'string',
            defaultValue: 'auto',
            label: [{ languageCode: LanguageCode.en, value: 'Carrier service slug (or auto)' }],
        },
        flatRateFallbackMinor: {
            type: 'int',
            defaultValue: 0,
            label: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Fallback price in minor units if Bolesa fails (0 = hide method)',
                },
            ],
        },
    },
    init(injector) {
        rateService = injector.get(BolesaRateService);
        connectionService = injector.get(BolesaConnectionService);
        bindRateCache(injector, rateService);
    },
    calculate: async (ctx, order, args) => {
        const preference = ((order as any).customFields?.paymentPreference ?? 'prepaid') as PaymentPreference;
        try {
            const conn = await connectionService.requireActive(ctx);
            const lookup = await rateService.lookupOptionsForOrder(ctx, order, preference);
            const option = rateService.pickOption(lookup.services, args.carrierServiceSlug);
            const prices = rateService.priceStateFor(lookup, option);
            if (!option) {
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
                        : lookup.services.length
                          ? 'slug_not_found'
                          : 'no_services',
                    priceMinor: null,
                    quotePersisted: false,
                });
                return undefined;
            }
            const built = rateService.buildQuote(
                option,
                preference,
                conn.markupPercent ?? 0,
                conn.codFeeMode ?? 'absorb',
                ctx.channel.defaultCurrencyCode,
            );
            if (!built) {
                logCalculation({
                    executed: true,
                    cacheHit: lookup.cacheHit,
                    httpStatus: lookup.httpStatus,
                    serviceCount: lookup.services.length,
                    ccPrice: prices.ccPrice,
                    codPrice: prices.codPrice,
                    outcome: 'undefined',
                    reason: 'missing_price',
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
                priceMinor: built.priceMinor,
                quotePersisted: false,
            });
            return {
                price: built.priceMinor,
                // Bolesa fee breakdown already includes VAT components; avoid double tax.
                priceIncludesTax: true,
                taxRate: 0,
                metadata: rateService.publicMetadata(built.quote),
            };
        } catch (e: any) {
            const httpStatus = e instanceof BolesaApiError ? e.status : null;
            const fallback = Number(args.flatRateFallbackMinor ?? 0);
            const useFallback = Number.isFinite(fallback) && fallback > 0;
            // Partner errors stay omitted unless an explicit positive fallback is configured.
            // A fallback of 0 must not be returned as a free shipping price.
            logCalculation({
                executed: true,
                cacheHit: false,
                httpStatus,
                serviceCount: 0,
                ccPrice: 'undefined',
                codPrice: 'undefined',
                outcome: useFallback ? 'price' : 'undefined',
                reason: 'partner_http_error',
                priceMinor: useFallback ? fallback : null,
                quotePersisted: false,
            });
            if (useFallback) {
                return {
                    price: fallback,
                    priceIncludesTax: true,
                    taxRate: 0,
                    metadata: { fallback: true },
                };
            }
            return undefined;
        }
    },
});

function logCalculation(entry: ShippingCalculationLog): void {
    const line = `bolesa.shipping.calculate ${JSON.stringify(entry)}`;
    if (entry.outcome === 'price' && entry.reason === 'quoted') {
        Logger.info(line, loggerCtx);
    } else {
        Logger.warn(line, loggerCtx);
    }
}
