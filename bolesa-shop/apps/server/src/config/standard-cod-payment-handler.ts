import {
    CreatePaymentResult,
    LanguageCode,
    PaymentMethodHandler,
    SettlePaymentResult,
} from '@vendure/core';

/** Handler code for shop-standard cash on delivery (not Bolesa). */
export const STANDARD_COD_HANDLER_CODE = 'standard-cod';

/**
 * Generic cash-on-delivery: authorize at checkout, settle later (e.g. after delivery).
 * Independent of Bolesa shipping / AWB COD collection.
 */
export const standardCodPaymentHandler = new PaymentMethodHandler({
    code: STANDARD_COD_HANDLER_CODE,
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Standard cash on delivery. The customer pays when the order is delivered.',
        },
        {
            languageCode: LanguageCode.ar,
            value: 'الدفع عند الاستلام. يدفع العميل عند تسليم الطلب.',
        },
    ],
    args: {},
    createPayment: async (_ctx, _order, amount): Promise<CreatePaymentResult> => ({
        amount,
        state: 'Authorized',
        transactionId: `cod-${Date.now()}`,
        metadata: { method: STANDARD_COD_HANDLER_CODE },
    }),
    settlePayment: async (): Promise<SettlePaymentResult> => ({ success: true }),
    cancelPayment: async () => ({
        success: true,
        metadata: { cancellationDate: new Date().toISOString() },
    }),
});
