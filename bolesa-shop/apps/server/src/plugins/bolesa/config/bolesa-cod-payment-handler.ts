import {
    CreatePaymentResult,
    LanguageCode,
    PaymentMethodHandler,
    SettlePaymentResult,
} from '@vendure/core';

import { BOLESA_COD_HANDLER_CODE } from '../constants';

/**
 * Two-step COD: authorize at checkout; settle only when Bolesa reports DELIVERED
 * (via reconciliation job calling OrderService.settlePayment).
 * Remittance to the merchant is tracked separately on BolesaShipment.codRemittanceStatus.
 */
export const bolesaCodPaymentHandler = new PaymentMethodHandler({
    code: BOLESA_COD_HANDLER_CODE,
    description: [{ languageCode: LanguageCode.en, value: 'Cash on delivery via Bolesa' }],
    args: {},
    createPayment: async (ctx, order, amount, args, metadata): Promise<CreatePaymentResult> => {
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
