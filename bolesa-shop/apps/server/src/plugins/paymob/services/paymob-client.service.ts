import { Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';

import { loggerCtx } from '../constants';
import { PaymobActiveCredentials } from '../types';

export class PaymobApiError extends Error {
    constructor(
        message: string,
        public readonly status?: number,
        public readonly body?: unknown,
    ) {
        super(message);
        this.name = 'PaymobApiError';
    }
}

export interface CreateIntentionInput {
    amountCents: number;
    currency: string;
    integrationId: number;
    billingData: Record<string, string>;
    items?: Array<{ name: string; amount: number; description?: string; quantity?: number }>;
    specialReference: string;
    notificationUrl: string;
    redirectionUrl: string;
    expiration?: number;
    extras?: Record<string, unknown>;
}

export interface IntentionResult {
    id: string | null;
    clientSecret: string;
    orderId: string | null;
    raw: Record<string, unknown>;
}

@Injectable()
export class PaymobClient {
    async createIntention(
        creds: PaymobActiveCredentials,
        input: CreateIntentionInput,
    ): Promise<IntentionResult> {
        const body = {
            amount: input.amountCents,
            currency: input.currency,
            payment_methods: [input.integrationId],
            items: input.items ?? [
                {
                    name: 'Order',
                    amount: input.amountCents,
                    description: input.specialReference,
                    quantity: 1,
                },
            ],
            billing_data: input.billingData,
            special_reference: input.specialReference.slice(0, 50),
            expiration: input.expiration ?? 3600,
            notification_url: input.notificationUrl,
            redirection_url: input.redirectionUrl,
            extras: input.extras ?? {},
        };

        const response = await fetch(`${creds.baseUrl}/v1/intention/`, {
            method: 'POST',
            headers: {
                Authorization: `Token ${creds.secretKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify(body),
        });

        const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
            Logger.error(
                `Paymob intention failed status=${response.status} body=${JSON.stringify(raw)}`,
                loggerCtx,
            );
            throw new PaymobApiError(
                typeof raw.detail === 'string'
                    ? raw.detail
                    : typeof raw.message === 'string'
                      ? raw.message
                      : 'Paymob intention creation failed',
                response.status,
                raw,
            );
        }

        const clientSecret = typeof raw.client_secret === 'string' ? raw.client_secret : '';
        if (!clientSecret) {
            throw new PaymobApiError(
                'Paymob intention creation failed. Check integration ID and currency compatibility.',
                response.status,
                raw,
            );
        }

        const orderIdRaw = raw.intention_order_id ?? raw.order_id ?? null;
        return {
            id: raw.id != null ? String(raw.id) : null,
            clientSecret,
            orderId: orderIdRaw != null ? String(orderIdRaw) : null,
            raw,
        };
    }

    buildPaymentUrl(creds: PaymobActiveCredentials, clientSecret: string): string {
        if (creds.iframeId) {
            return `${creds.baseUrl}/iframe/${creds.iframeId}?payment_token=${encodeURIComponent(clientSecret)}`;
        }
        const publicKey = encodeURIComponent(creds.publicKey.trim());
        const secret = encodeURIComponent(clientSecret);
        return `${creds.baseUrl}/unifiedcheckout/?publicKey=${publicKey}&clientSecret=${secret}`;
    }

    async inquireOrderTransaction(
        creds: PaymobActiveCredentials,
        orderId: string,
    ): Promise<Record<string, unknown>> {
        const authToken = await this.getAuthToken(creds);
        const response = await fetch(`${creds.baseUrl}/api/ecommerce/orders/transaction_inquiry`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({ order_id: orderId }),
        });
        const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
            throw new PaymobApiError(
                typeof raw.detail === 'string' ? raw.detail : 'Paymob transaction inquiry failed',
                response.status,
                raw,
            );
        }
        return raw;
    }

    private async getAuthToken(creds: PaymobActiveCredentials): Promise<string> {
        const response = await fetch(`${creds.baseUrl}/api/auth/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ api_key: creds.apiKey }),
        });
        const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok || typeof raw.token !== 'string') {
            throw new PaymobApiError('Paymob auth token request failed', response.status, raw);
        }
        return raw.token;
    }
}
