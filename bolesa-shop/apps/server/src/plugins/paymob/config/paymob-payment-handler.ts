import {
    CreatePaymentResult,
    Injector,
    LanguageCode,
    Logger,
    PaymentMethodHandler,
    SettlePaymentResult,
} from '@vendure/core';

import { PAYMOB_HANDLER_CODE, PAYMOB_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { PaymobClient, PaymobApiError } from '../services/paymob-client.service';
import { PaymobConnectionService } from '../services/paymob-connection.service';
import { PaymobPluginOptions } from '../types';
import { resolveIntegrationId } from '../util/credentials';

let connectionService: PaymobConnectionService | undefined;
let paymobClient: PaymobClient | undefined;
let pluginOptions: PaymobPluginOptions | undefined;

function billingFromOrder(order: {
    customer?: { firstName?: string; lastName?: string; emailAddress?: string; phoneNumber?: string } | null;
    shippingAddress?: {
        fullName?: string;
        phoneNumber?: string;
        streetLine1?: string;
        city?: string;
        countryCode?: string;
        postalCode?: string;
        province?: string;
    } | null;
    billingAddress?: {
        fullName?: string;
        phoneNumber?: string;
        streetLine1?: string;
        city?: string;
        countryCode?: string;
        postalCode?: string;
        province?: string;
    } | null;
}): Record<string, string> {
    const addr = order.billingAddress?.streetLine1 ? order.billingAddress : order.shippingAddress;
    const fullName = addr?.fullName || [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || 'Customer';
    const parts = fullName.trim().split(/\s+/);
    const firstName = parts[0] || 'Customer';
    const lastName = parts.slice(1).join(' ') || 'Name';
    return {
        first_name: firstName,
        last_name: lastName,
        email: order.customer?.emailAddress || 'customer@example.com',
        phone_number: addr?.phoneNumber || order.customer?.phoneNumber || '01000000000',
        apartment: 'N/A',
        floor: 'N/A',
        building: 'N/A',
        street: addr?.streetLine1 || 'N/A',
        city: addr?.city || 'Cairo',
        country: addr?.countryCode || 'EG',
        state: addr?.province || addr?.city || 'Cairo',
        postal_code: addr?.postalCode || '00000',
    };
}

export const paymobPaymentHandler = new PaymentMethodHandler({
    code: PAYMOB_HANDLER_CODE,
    description: [
        { languageCode: LanguageCode.en, value: 'Pay with card via Paymob' },
        { languageCode: LanguageCode.ar, value: 'الدفع بالبطاقة عبر Paymob' },
    ],
    args: {},
    init(injector: Injector) {
        connectionService = injector.get(PaymobConnectionService);
        paymobClient = injector.get(PaymobClient);
        pluginOptions = injector.get(PAYMOB_PLUGIN_OPTIONS);
    },
    createPayment: async (ctx, order, amount, _args, _metadata): Promise<CreatePaymentResult> => {
        if (!connectionService || !paymobClient || !pluginOptions) {
            return {
                amount,
                state: 'Declined',
                errorMessage: 'Paymob is not initialized',
            };
        }
        try {
            const conn = await connectionService.requireActive(ctx);
            const creds = connectionService.activeCredentials(conn);
            const integrationIdRaw = resolveIntegrationId(
                order.currencyCode,
                creds.integrationIdsByCurrency,
            );
            if (!integrationIdRaw) {
                return {
                    amount,
                    state: 'Declined',
                    errorMessage: `No Paymob integration ID configured for currency ${order.currencyCode}`,
                };
            }
            const integrationId = Number(integrationIdRaw);
            if (!Number.isFinite(integrationId)) {
                return {
                    amount,
                    state: 'Declined',
                    errorMessage: `Invalid Paymob integration ID for ${order.currencyCode}`,
                };
            }

            const serverBase = pluginOptions.serverBaseUrl.replace(/\/$/, '');
            const notificationUrl = `${serverBase}/payments/paymob/notification`;
            const redirectionUrl = `${serverBase}/payments/paymob/return?orderCode=${encodeURIComponent(order.code)}`;

            const intention = await paymobClient.createIntention(creds, {
                amountCents: amount,
                currency: order.currencyCode,
                integrationId,
                billingData: billingFromOrder(order),
                specialReference: order.code,
                notificationUrl,
                redirectionUrl,
                extras: {
                    orderCode: order.code,
                    channelId: String(ctx.channelId),
                    mode: conn.mode,
                },
            });

            const redirectUrl = paymobClient.buildPaymentUrl(creds, intention.clientSecret);
            const transactionId = intention.orderId || intention.id || order.code;

            Logger.info(
                `Paymob intention created order=${order.code} intention=${intention.id} paymobOrder=${intention.orderId}`,
                loggerCtx,
            );

            return {
                amount,
                state: 'Authorized',
                transactionId,
                metadata: {
                    intentionId: intention.id,
                    paymobOrderId: intention.orderId,
                    mode: conn.mode,
                    public: {
                        redirectUrl,
                    },
                },
            };
        } catch (e: any) {
            const message =
                e instanceof PaymobApiError ? e.message : e?.message || 'Paymob payment failed';
            Logger.warn(`Paymob createPayment failed: ${message}`, loggerCtx);
            return {
                amount,
                state: 'Declined',
                errorMessage: message,
            };
        }
    },
    settlePayment: async (_ctx, _payment): Promise<SettlePaymentResult> => {
        // Only invoked after HMAC-verified notification/return (or admin settle).
        return { success: true, metadata: { paymobSettled: true } };
    },
});
