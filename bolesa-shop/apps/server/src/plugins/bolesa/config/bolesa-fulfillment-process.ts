import { FulfillmentProcess } from '@vendure/core';

/**
 * Adds a Returned state for Bolesa return flows (Shipped|Delivered → Returned).
 * Fine-grained Bolesa statuses stay on customFields.bolesaStatus.
 * Only appends Returned — default Shipped/Delivered targets are kept via merge.
 */
export const bolesaFulfillmentProcess: FulfillmentProcess<'Returned'> = {
    transitions: {
        Shipped: {
            to: ['Returned'],
        },
        Delivered: {
            to: ['Returned'],
        },
        Returned: {
            to: [],
        },
    },
};
