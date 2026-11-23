import { LanguageCode, Logger, ShippingCalculator } from '@vendure/core';

import { BOLESA_SHIPPING_CALCULATOR_CODE, loggerCtx } from '../constants';
import { BolesaApiError } from '../services/bolesa-client.service';
import { BolesaConnectionService } from '../services/bolesa-connection.service';
import { bindRateCache, BolesaRateService } from '../services/bolesa-rate.service';
import { merchantServiceSlugs } from '../util/merchant-services';
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
            const enabled = merchantServiceSlugs(conn.enabledServiceSlugs);
            const offered = enabled.length
                ? lookup.services.filter(service => enabled.includes(service.slug))
                : lookup.services;
            const customerSlug = String((order as any).customFields?.bolesaServiceSlug ?? '').trim();
            const defaultSlug = String(conn.defaultServiceSlug ?? '').trim();
            const choices = rateService.quoteChoices(
                offered,
                preference,
                conn.markupPercent ?? 0,
                conn.codFeeMode ?? 'absorb',
                ctx.channel.defaultCurrencyCode,
            );
            // A shopper's choice that cannot be quoted hides the method.
            // The merchant default is only the price shown before they choose.
            // If that default has no quote, the other priced carriers stay available.
            const customerChoice = customerSlug && customerSlug !== 'auto' ? customerSlug : '';
            const chosen = customerChoice
                ? choices.find(choice => choice.slug === customerChoice)
                : choices.find(choice => choice.slug === defaultSlug) ?? choices[0];
            const blockedReason = !chosen
                ? customerChoice && enabled.length && !enabled.includes(customerChoice)
                    ? 'service_not_enabled'
                    : customerChoice
                      ? 'slug_not_found'
                      : offered.length
                        ? 'missing_price'
                        : 'no_services'
                : undefined;
            const option = chosen
                ? lookup.services.find(service => service.slug === chosen.slug)
                : undefined;
            const prices = rateService.priceStateFor(lookup, option);
            if (!option || !chosen) {
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
                        : blockedReason === 'service_not_enabled' || blockedReason === 'slug_not_found'
                          ? blockedReason
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
                    reason:
                        currencyBlockReason([option], ctx.channel.defaultCurrencyCode) ?? 'missing_price',
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
                metadata: {
                    ...rateService.publicMetadata(built.quote),
                    options: choices,
                },
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
