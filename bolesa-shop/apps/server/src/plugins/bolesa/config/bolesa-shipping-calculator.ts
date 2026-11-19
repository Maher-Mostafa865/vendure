import { LanguageCode, Logger, ShippingCalculator } from '@vendure/core';

import { BOLESA_SHIPPING_CALCULATOR_CODE, loggerCtx } from '../constants';
import { BolesaConnectionService } from '../services/bolesa-connection.service';
import { bindRateCache, BolesaRateService } from '../services/bolesa-rate.service';
import { PaymentPreference } from '../types';

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
            const services = await rateService.getOptionsForOrder(ctx, order, preference);
            const option = rateService.pickOption(services, args.carrierServiceSlug);
            if (!option) {
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
                return undefined;
            }
            return {
                price: built.priceMinor,
                // Bolesa fee breakdown already includes VAT components; avoid double tax.
                priceIncludesTax: true,
                taxRate: 0,
                metadata: rateService.publicMetadata(built.quote),
            };
        } catch (e: any) {
            Logger.warn(`Bolesa rate calculator failed: ${e?.message}`, loggerCtx);
            const fallback = Number(args.flatRateFallbackMinor ?? 0);
            if (fallback > 0) {
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
