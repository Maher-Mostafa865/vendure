import {
    CreatePaymentResult,
    LanguageCode,
    PaymentMethodHandler,
    SettlePaymentResult,
} from '@vendure/core';

import { BOLESA_COD_HANDLER_CODE } from '../constants';
import { BolesaConnectionService } from '../services/bolesa-connection.service';
import { BolesaRateService } from '../services/bolesa-rate.service';
import { merchantServiceSlugs } from '../util/merchant-services';
import { orderMinimumMinor } from './bolesa-cod-eligibility-checker';
import { evaluateCodPayment, normalizeServiceOffers, quoteCustomerShipping } from '../util/service-offer';
import { PaymentPreference } from '../types';

let connectionService: BolesaConnectionService | undefined;
let rateService: BolesaRateService | undefined;

/**
 * Two-step COD: authorize at checkout; settle only when Bolesa reports DELIVERED
 * (via reconciliation job calling OrderService.settlePayment).
 * Remittance to the merchant is tracked separately on BolesaShipment.codRemittanceStatus.
 */
export const bolesaCodPaymentHandler = new PaymentMethodHandler({
    code: BOLESA_COD_HANDLER_CODE,
    description: [
        { languageCode: LanguageCode.en, value: 'Cash on delivery. The customer pays the courier.' },
        { languageCode: LanguageCode.ar, value: 'الدفع عند الاستلام. العميل يدفع للمندوب.' },
    ],
    args: {},
    init(injector) {
        connectionService = injector.get(BolesaConnectionService);
        rateService = injector.get(BolesaRateService);
    },
    createPayment: async (ctx, order, amount, args, metadata, method): Promise<CreatePaymentResult> => {
        const minimumMinor = orderMinimumMinor(method?.checker);
        const goods = order.subTotalWithTax;
        if (typeof goods === 'number' && goods < minimumMinor) {
            return {
                amount,
                state: 'Declined',
                errorMessage: 'Cash on delivery is not available for this order.',
            };
        }
        if (connectionService && rateService) {
            const conn = await connectionService.getForChannel(ctx);
            const preference = ((order as any).customFields?.paymentPreference ?? null) as PaymentPreference | null;
            let quotedMinor: number | null = null;
            if (conn?.isActive && preference === 'cod') {
                try {
                    const lookup = await rateService.lookupOptionsForOrder(ctx, order, 'cod');
                    const quoted = quoteCustomerShipping({
                        services: lookup.services,
                        enabledSlugs: merchantServiceSlugs(conn.enabledServiceSlugs),
                        offers: normalizeServiceOffers(conn.serviceOffers),
                        preference: 'cod',
                        currencyCode: ctx.channel.defaultCurrencyCode,
                    });
                    quotedMinor = quoted?.customerPriceMinor ?? null;
                } catch {
                    quotedMinor = null;
                }
            }
            if (conn?.isActive) {
                const linePrice = order.shippingLines?.[0]?.priceWithTax;
                const charged = typeof linePrice === 'number' ? linePrice : order.shippingWithTax;
                const decision = evaluateCodPayment({
                    codEnabled: conn.codEnabled !== false,
                    subTotalWithTax: typeof goods === 'number' ? goods : Number.NaN,
                    minimumMinor,
                    paymentPreference: preference,
                    quotedMinor,
                    chargedMinor: typeof charged === 'number' ? charged : null,
                });
                if (!decision.ok) {
                    return {
                        amount,
                        state: 'Declined',
                        errorMessage: decision.errorMessage,
                    };
                }
            }
        }
        return {
            amount,
            state: 'Authorized',
            transactionId: String(order.code),
            metadata: {
                ...(metadata ?? {}),
                method: 'bolesa-cod',
                note: 'Settled when carrier marks DELIVERED; remittance tracked separately',
            },
        };
    },
    settlePayment: async (): Promise<SettlePaymentResult> => {
        return { success: true };
    },
    cancelPayment: async () => {
        return { success: true };
    },
});
