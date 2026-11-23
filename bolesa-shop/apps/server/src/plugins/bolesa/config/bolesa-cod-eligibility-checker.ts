import { LanguageCode, PaymentMethodEligibilityChecker } from '@vendure/core';

/** Minor units stored on the payment method. Missing or invalid means no minimum. */
export function orderMinimumMinor(checker: { args?: Array<{ name?: string; value?: string }> } | null | undefined): number {
    const raw = checker?.args?.find(arg => arg.name === 'orderMinimum')?.value;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
    }
    return Math.round(parsed);
}

/**
 * Configured on the payment method, not on the Bolesa connection.
 * The field appears under Payment eligibility checker.
 */
export const bolesaCodEligibilityChecker = new PaymentMethodEligibilityChecker({
    code: 'bolesa-cod-eligibility',
    description: [
        { languageCode: LanguageCode.en, value: 'Minimum goods total' },
        { languageCode: LanguageCode.ar, value: 'الحد الأدنى لمجموع البضاعة' },
    ],
    args: {
        orderMinimum: {
            type: 'int',
            defaultValue: 0,
            ui: { component: 'currency-form-input' },
            label: [
                { languageCode: LanguageCode.en, value: 'Minimum goods total' },
                { languageCode: LanguageCode.ar, value: 'الحد الأدنى لمجموع البضاعة' },
            ],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Cash on delivery is offered only when the goods total reaches this amount.',
                },
                {
                    languageCode: LanguageCode.ar,
                    value: 'الدفع عند الاستلام يظهر فقط عندما يصل مجموع البضاعة إلى هذا المبلغ.',
                },
            ],
        },
    },
    check: (_ctx, order, args) => {
        if (order.subTotalWithTax >= args.orderMinimum) {
            return true;
        }
        return 'Cash on delivery is available when the goods total reaches the minimum.';
    },
});
