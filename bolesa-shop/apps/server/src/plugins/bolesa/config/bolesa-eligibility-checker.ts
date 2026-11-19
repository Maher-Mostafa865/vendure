import { LanguageCode, ShippingEligibilityChecker } from '@vendure/core';

import { BOLESA_ELIGIBILITY_CHECKER_CODE } from '../constants';
import { BolesaConnectionService } from '../services/bolesa-connection.service';

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
        if (!hash) {
            return false;
        }
        const country = (order.shippingAddress?.countryCode ?? 'EG').toUpperCase();
        if (country !== 'EG') {
            // Phase 1 MVP: domestic Egypt only
            return false;
        }
        try {
            await connectionService.requireActive(ctx);
            return true;
        } catch {
            return false;
        }
    },
});
