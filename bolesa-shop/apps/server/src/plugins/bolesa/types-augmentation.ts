/**
 * Augment Vendure fulfillment states with Returned (Bolesa return AWB terminal).
 */
declare module '@vendure/core/dist/service/helpers/fulfillment-state-machine/fulfillment-state.js' {
    interface CustomFulfillmentStates {
        Returned: never;
    }
}

export {};
