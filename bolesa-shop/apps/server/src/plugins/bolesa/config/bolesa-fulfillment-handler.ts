import {
    FulfillmentHandler,
    LanguageCode,
    Logger,
    OrderService,
    UserInputError,
} from '@vendure/core';

import { BOLESA_FULFILLMENT_HANDLER_CODE, loggerCtx } from '../constants';
import { BolesaConnectionService } from '../services/bolesa-connection.service';

/**
 * Revision 2: createFulfillment must NOT call Bolesa HTTP.
 * Outbox row + AWB job are created after commit via FulfillmentEvent → BolesaShipmentService.
 */
let connectionService: BolesaConnectionService;
let orderService: OrderService;

export const bolesaFulfillmentHandler = new FulfillmentHandler({
    code: BOLESA_FULFILLMENT_HANDLER_CODE,
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Create the Bolesa shipment when you fulfill the order. Payment does not create it.',
        },
        {
            languageCode: LanguageCode.ar,
            value: 'إنشاء شحنة Bolesa عند تنفيذ الطلب. الدفع لا ينشئ الشحنة.',
        },
    ],
    args: {},
    init(injector) {
        connectionService = injector.get(BolesaConnectionService);
        orderService = injector.get(OrderService);
    },
    createFulfillment: async (ctx, orders, lines) => {
        const orderRef = orders[0];
        if (!orderRef) {
            throw new UserInputError('No order for fulfillment');
        }
        // OrderService may pass Order entities without relations loaded.
        const order =
            (await orderService.findOne(ctx, orderRef.id, [
                'lines',
                'lines.productVariant',
            ])) ?? orderRef;
        if (!Array.isArray(order.lines)) {
            throw new UserInputError(`Order ${orderRef.id} has no lines available for fulfillment`);
        }
        await connectionService.requireActive(ctx);

        const carrier = String((order as any).customFields?.bolesaServiceSlug ?? '').trim();
        if (!carrier || carrier === 'auto' || carrier === 'default') {
            throw new UserInputError('Choose a carrier on this order before creating the fulfillment.');
        }

        const hash = (order.shippingAddress as any)?.customFields?.bolesaCityHash;
        if (!hash) {
            throw new UserInputError('Shipping address is missing Bolesa city resolution hash');
        }

        for (const line of order.lines) {
            const weight = (line.productVariant as any)?.customFields?.weightKg;
            if (weight == null || Number(weight) <= 0) {
                throw new UserInputError(
                    `ProductVariant ${line.productVariant.sku} is missing customFields.weightKg`,
                );
            }
        }

        const preference = (order as any).customFields?.paymentPreference ?? 'prepaid';
        if (preference === 'cod') {
            // MVP: COD must be a single full fulfillment covering all remaining quantity.
            const lineIds = new Set(lines.map(l => String(l.orderLineId)));
            const uncovered = order.lines.some(l => !lineIds.has(String(l.id)));
            if (uncovered || lines.length === 0) {
                throw new UserInputError(
                    'COD orders must be fulfilled as a single complete fulfillment covering all lines',
                );
            }
            Logger.debug(`COD order ${order.code}: full-fulfillment check passed`, loggerCtx);
        }

        // Outbox row is created after Fulfillment exists — see BolesaShipmentService.onFulfillmentCreated
        // which is triggered by FulfillmentEvent. Here we only return sync metadata.
        return {
            method: 'Bolesa',
            trackingCode: '',
            customFields: {
                bolesaSyncStatus: 'requested',
                bolesaLabelAvailability: 'unavailable',
            },
        };
    },
    onFulfillmentTransition: async (fromState, toState, data) => {
        if (toState === 'Cancelled' && data.fulfillment.handlerCode === BOLESA_FULFILLMENT_HANDLER_CODE) {
            const status = (data.fulfillment as any).customFields?.bolesaStatus;
            if (status && status !== 'CANCELED') {
                return 'Use Cancel Bolesa shipment (async job). Manual Cancelled is blocked until Bolesa confirms CANCELED.';
            }
        }
        return true;
    },
});
