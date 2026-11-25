import { LanguageCode, Logger, ShippingEligibilityChecker } from '@vendure/core';

import { BOLESA_ELIGIBILITY_CHECKER_CODE, loggerCtx } from '../constants';
import { BolesaConnectionService } from '../services/bolesa-connection.service';

export type EligibilityFailReason =
    | 'missing_city_hash'
    | 'country_mismatch'
    | 'connection_inactive';

let connectionService: BolesaConnectionService;

/** Channel market country (EG|SA). Defaults to EG when unset. */
export function channelMarketCountry(channel: { customFields?: { marketCountry?: string | null } } | null | undefined): string {
    const raw = channel?.customFields?.marketCountry;
    const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    return code || 'EG';
}

export const bolesaEligibilityChecker = new ShippingEligibilityChecker({
    code: BOLESA_ELIGIBILITY_CHECKER_CODE,
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Addresses in the channel market country only, while the Bolesa connection is active',
        },
        {
            languageCode: LanguageCode.ar,
            value: 'عناوين دولة قناة المتجر فقط، وعندما يكون اتصال Bolesa شغالاً',
        },
    ],
    args: {},
    init(injector) {
        connectionService = injector.get(BolesaConnectionService);
    },
    shouldRunCheck: (ctx, order) => {
        const hash = (order.shippingAddress as any)?.customFields?.bolesaCityHash ?? '';
        const preference = (order as any).customFields?.paymentPreference ?? 'prepaid';
        return JSON.stringify({
            channelId: ctx.channelId,
            hash,
            preference,
            qty: order.totalQuantity,
            country: order.shippingAddress?.countryCode ?? '',
            market: channelMarketCountry(ctx.channel as any),
        });
    },
    check: async (ctx, order) => {
        const hash = (order.shippingAddress as any)?.customFields?.bolesaCityHash;
        const market = channelMarketCountry(ctx.channel as any);
        const countryCode = (order.shippingAddress?.countryCode ?? market).toUpperCase();
        if (!hash) {
            logEligibility(false, 'missing_city_hash', countryCode, market);
            return false;
        }
        if (countryCode !== market) {
            logEligibility(false, 'country_mismatch', countryCode, market);
            return false;
        }
        try {
            await connectionService.requireActive(ctx);
            logEligibility(true, 'eligible', countryCode, market);
            return true;
        } catch {
            logEligibility(false, 'connection_inactive', countryCode, market);
            return false;
        }
    },
});

function logEligibility(
    eligible: boolean,
    reason: EligibilityFailReason | 'eligible',
    countryCode: string,
    marketCountry: string,
): void {
    const line = `bolesa.shipping.eligibility ${JSON.stringify({
        executed: true,
        eligible,
        reason,
        countryCode,
        marketCountry,
        hasCityHash: reason !== 'missing_city_hash',
    })}`;
    if (eligible) {
        Logger.verbose(line, loggerCtx);
    } else {
        Logger.warn(line, loggerCtx);
    }
}
