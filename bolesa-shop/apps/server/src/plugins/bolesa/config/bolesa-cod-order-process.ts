import { OrderProcess } from '@vendure/core';

/**
 * COD stays in PaymentAuthorized until delivery settles the payment.
 * Default Vendure only opens Shipped/PartiallyShipped from PaymentSettled, which
 * hides the dashboard "Fulfill order" button for COD. Merge these transitions so
 * authorized COD orders can be fulfilled and AWB-created.
 */
export const bolesaCodOrderProcess: OrderProcess<'PaymentAuthorized'> = {
    transitions: {
        PaymentAuthorized: {
            to: ['PartiallyShipped', 'Shipped'],
        },
    },
};
