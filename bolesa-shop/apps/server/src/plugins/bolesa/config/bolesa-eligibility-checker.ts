import { LanguageCode, Logger, ShippingEligibilityChecker } from '@vendure/core';

import { BOLESA_ELIGIBILITY_CHECKER_CODE, loggerCtx } from '../constants';
import { BolesaConnectionService } from '../services/bolesa-connection.service';

export type EligibilityFailReason = 'missing_city_hash' | 'country_not_eg' | 'connection_inactive';

let connectionService: BolesaConnectionService;

export const bolesaEligibilityChecker = new ShippingEligibilityChecker({
    code: BOLESA_ELIGIBILITY_CHECKER_CODE,
    description: [{ languageCode: LanguageCode.en, value: 'Eligible when Bolesa city hash is set and connection is active' }],
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
        });
    },
    check: async (ctx, order) => {
        const hash = (order.shippingAddress as any)?.customFields?.bolesaCityHash;
        const countryCode = (order.shippingAddress?.countryCode ?? 'EG').toUpperCase();
        if (!hash) {
            logEligibility(false, 'missing_city_hash', countryCode);
            return false;
        }
        if (countryCode !== 'EG') {
            // Phase 1 MVP: domestic Egypt only
            logEligibility(false, 'country_not_eg', countryCode);
            return false;
        }
        try {
            await connectionService.requireActive(ctx);
            logEligibility(true, 'eligible', countryCode);
            return true;
        } catch {
            logEligibility(false, 'connection_inactive', countryCode);
            return false;
        }
    },
});

function logEligibility(
    eligible: boolean,
    reason: EligibilityFailReason | 'eligible',
    countryCode: string,
): void {
    const line = `bolesa.shipping.eligibility ${JSON.stringify({
        executed: true,
        eligible,
        reason,
        countryCode,
        hasCityHash: reason !== 'missing_city_hash',
    })}`;
    if (eligible) {
        Logger.verbose(line, loggerCtx);
    } else {
        Logger.warn(line, loggerCtx);
    }
}
