import { Injectable } from '@nestjs/common';
import {
    ChannelService,
    ConfigService,
    ID,
    Logger,
    Order,
    OrderService,
    Payment,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
    User,
    isGraphQlErrorResult,
} from '@vendure/core';

import { loggerCtx } from '../constants';
import { PaymobConnection } from '../entities/paymob-connection.entity';
import { PaymobClient } from './paymob-client.service';
import { PaymobConnectionService } from './paymob-connection.service';
import {
    extractPaymobTransactionPayload,
    isPaymobSuccess,
    verifyPaymobHmac,
} from '../util/hmac';

@Injectable()
export class PaymobSettlementService {
    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private orderService: OrderService,
        private requestContextService: RequestContextService,
        private configService: ConfigService,
        private paymobConnectionService: PaymobConnectionService,
        private paymobClient: PaymobClient,
    ) {}

    async handleCallback(input: {
        body?: Record<string, unknown>;
        query?: Record<string, unknown>;
        orderCodeHint?: string | null;
    }): Promise<{ ok: boolean; settled: boolean; orderCode: string | null; message: string }> {
        const { payload, hmac } = extractPaymobTransactionPayload(input.body, input.query);
        const orderCode =
            input.orderCodeHint ||
            (typeof payload.merchant_order_id === 'string' && payload.merchant_order_id) ||
            (typeof (payload.order as any)?.merchant_order_id === 'string' &&
                (payload.order as any).merchant_order_id) ||
            (typeof payload.special_reference === 'string' && payload.special_reference) ||
            null;

        const paymobOrderId = this.readPaymobOrderId(payload);

        const payment = await this.findPayment({
            orderCode,
            transactionId: paymobOrderId || (payload.id != null ? String(payload.id) : null),
        });

        if (!payment?.order) {
            Logger.warn(
                `Paymob callback: payment not found orderCode=${orderCode} tx=${paymobOrderId}`,
                loggerCtx,
            );
            return { ok: false, settled: false, orderCode, message: 'Payment not found' };
        }

        const order = payment.order.channels
            ? payment.order
            : await this.connection.rawConnection.getRepository(Order).findOne({
                  where: { id: payment.order.id },
                  relations: ['channels'],
              });
        if (!order) {
            return { ok: false, settled: false, orderCode, message: 'Order not found' };
        }

        const channelEntity = order.channels?.[0];
        if (!channelEntity) {
            return { ok: false, settled: false, orderCode: order.code, message: 'Channel not found' };
        }
        const channel =
            typeof channelEntity.token === 'string'
                ? channelEntity
                : await this.channelService.findOne(await this.anonymousCtx(), channelEntity.id as ID);
        if (!channel) {
            return { ok: false, settled: false, orderCode: order.code, message: 'Channel not found' };
        }

        const ctx = await this.adminCtxForChannel(channel.token);
        const conn = await this.paymobConnectionService.getForChannel(ctx);
        if (!conn) {
            return { ok: false, settled: false, orderCode: order.code, message: 'Paymob not configured' };
        }

        const verified = this.verifyHmacAgainstConnection(conn, payload, hmac);
        let success = isPaymobSuccess(payload);

        if (!verified) {
            // Localhost cannot receive Paymob server webhooks; browser return often arrives
            // without a verifiable HMAC. Confirm with Paymob transaction inquiry instead.
            Logger.warn(
                `Paymob HMAC missing/invalid for order ${order.code}; falling back to inquiry`,
                loggerCtx,
            );
            const inquired = await this.inquireSuccess(conn, payment);
            if (inquired == null) {
                return {
                    ok: false,
                    settled: false,
                    orderCode: order.code,
                    message: 'Invalid HMAC and inquiry failed',
                };
            }
            success = inquired;
        }

        if (!success) {
            Logger.info(`Paymob callback unsuccessful for order ${order.code}`, loggerCtx);
            await this.patchPaymentMetadata(payment.id, {
                paymobSuccess: false,
                paymobCallback: summarize(payload),
            });
            return {
                ok: true,
                settled: false,
                orderCode: order.code,
                message: 'Payment not successful',
            };
        }

        if (payment.state === 'Settled') {
            return { ok: true, settled: true, orderCode: order.code, message: 'Already settled' };
        }

        await this.patchPaymentMetadata(payment.id, {
            paymobSuccess: true,
            paymobCallback: summarize(payload),
        });

        const result = await this.orderService.settlePayment(ctx, payment.id);
        if (isGraphQlErrorResult(result)) {
            Logger.warn(
                `Paymob settle failed for order ${order.code}: ${(result as any).message}`,
                loggerCtx,
            );
            return {
                ok: false,
                settled: false,
                orderCode: order.code,
                message: (result as any).message ?? 'Settle failed',
            };
        }

        Logger.info(`Paymob payment settled for order ${order.code}`, loggerCtx);
        return { ok: true, settled: true, orderCode: order.code, message: 'Settled' };
    }

    /** Settle a stuck Authorized Paymob payment by inquiring Paymob (admin/ops helper). */
    async settleByInquiry(orderCode: string): Promise<{ ok: boolean; settled: boolean; message: string }> {
        const payment = await this.findPayment({ orderCode, transactionId: null });
        if (!payment?.order) {
            return { ok: false, settled: false, message: 'Payment not found' };
        }
        if (payment.state === 'Settled') {
            return { ok: true, settled: true, message: 'Already settled' };
        }
        const channel = payment.order.channels?.[0];
        if (!channel?.token) {
            return { ok: false, settled: false, message: 'Channel not found' };
        }
        const ctx = await this.adminCtxForChannel(channel.token);
        const conn = await this.paymobConnectionService.getForChannel(ctx);
        if (!conn) {
            return { ok: false, settled: false, message: 'Paymob not configured' };
        }
        const success = await this.inquireSuccess(conn, payment);
        if (!success) {
            return { ok: false, settled: false, message: 'Paymob reports payment not successful' };
        }
        await this.patchPaymentMetadata(payment.id, { paymobSuccess: true, settledVia: 'inquiry' });
        const result = await this.orderService.settlePayment(ctx, payment.id);
        if (isGraphQlErrorResult(result)) {
            return { ok: false, settled: false, message: (result as any).message ?? 'Settle failed' };
        }
        return { ok: true, settled: true, message: 'Settled' };
    }

    private verifyHmacAgainstConnection(
        conn: PaymobConnection,
        payload: Record<string, unknown>,
        hmac: string | null,
    ): boolean {
        if (!hmac) {
            return false;
        }
        let hmacSecret = '';
        try {
            hmacSecret = this.paymobConnectionService.activeCredentials(conn).hmacSecret;
        } catch {
            hmacSecret = this.anyHmacSecret(conn) ?? '';
        }
        if (hmacSecret && verifyPaymobHmac(payload, hmac, hmacSecret)) {
            return true;
        }
        const alt = this.anyHmacSecret(conn, hmacSecret);
        return Boolean(alt && verifyPaymobHmac(payload, hmac, alt));
    }

    private async inquireSuccess(conn: PaymobConnection, payment: Payment): Promise<boolean | null> {
        const orderId =
            String((payment.metadata as any)?.paymobOrderId ?? '') ||
            String(payment.transactionId ?? '');
        if (!orderId) {
            return null;
        }
        try {
            const creds = this.paymobConnectionService.activeCredentials(conn);
            const raw = await this.paymobClient.inquireOrderTransaction(creds, orderId);
            if ((raw as any)._not_found) {
                return false;
            }
            if (isPaymobSuccess(raw)) {
                return true;
            }
            if (raw.success === true || raw.success === 'true') {
                return true;
            }
            // Intention / ecommerce inquiry shapes
            const status = String((raw as any).status ?? (raw as any).order?.payment_status ?? '').toUpperCase();
            if (['PAID', 'CAPTURED', 'SUCCESS', 'SUCCESSFUL'].includes(status)) {
                return true;
            }
            if ((raw as any).is_captured === true) {
                return true;
            }
            Logger.info(
                `Paymob inquiry for ${orderId}: success=${String(raw.success)} status=${status}`,
                loggerCtx,
            );
            return false;
        } catch (e: any) {
            Logger.warn(`Paymob inquiry failed: ${e?.message ?? e}`, loggerCtx);
            return null;
        }
    }

    private readPaymobOrderId(payload: Record<string, unknown>): string | null {
        if (payload.order != null) {
            if (typeof payload.order === 'object' && (payload.order as any).id != null) {
                return String((payload.order as any).id);
            }
            return String(payload.order);
        }
        return null;
    }

    private anyHmacSecret(conn: PaymobConnection, exclude?: string): string | null {
        const strategy = this.configService.systemOptions.encryptionStrategy;
        if (!strategy?.isConfigured()) return null;
        for (const stored of [conn.testCredentials, conn.liveCredentials]) {
            if (!stored?.hmacSecretEncrypted) continue;
            try {
                const secret = strategy.decrypt(stored.hmacSecretEncrypted);
                if (secret && secret !== exclude) return secret;
            } catch {
                /* ignore */
            }
        }
        return null;
    }

    private async findPayment(input: {
        orderCode: string | null;
        transactionId: string | null;
    }): Promise<Payment | null> {
        const repo = this.connection.rawConnection.getRepository(Payment);
        if (input.transactionId) {
            const byTx = await repo.findOne({
                where: { transactionId: input.transactionId },
                relations: ['order', 'order.channels'],
            });
            if (byTx) return byTx;
        }
        if (input.orderCode) {
            const order = await this.connection.rawConnection.getRepository(Order).findOne({
                where: { code: input.orderCode },
                relations: ['payments', 'channels'],
            });
            if (!order) return null;
            const payments = order.payments ?? [];
            const selected =
                payments
                    .filter(p => p.method?.includes('paymob') || (p.metadata as any)?.intentionId)
                    .sort((a, b) => Number(b.id) - Number(a.id))[0] ??
                payments.sort((a, b) => Number(b.id) - Number(a.id))[0] ??
                null;
            if (!selected) return null;
            selected.order = order;
            return selected;
        }
        return null;
    }

    private async patchPaymentMetadata(paymentId: ID, patch: Record<string, unknown>): Promise<void> {
        const repo = this.connection.rawConnection.getRepository(Payment);
        const payment = await repo.findOne({ where: { id: paymentId } });
        if (!payment) return;
        payment.metadata = { ...(payment.metadata ?? {}), ...patch };
        await repo.save(payment);
    }

    private async anonymousCtx(): Promise<RequestContext> {
        return this.requestContextService.create({ apiType: 'admin' });
    }

    private async adminCtxForChannel(channelToken: string): Promise<RequestContext> {
        const { superadminCredentials } = this.configService.authOptions;
        const user = await this.connection.rawConnection.getRepository(User).findOne({
            where: { identifier: superadminCredentials.identifier },
            relations: { roles: { channels: true } },
        });
        return this.requestContextService.create({
            apiType: 'admin',
            channelOrToken: channelToken,
            user: user ?? undefined,
        });
    }
}

function summarize(payload: Record<string, unknown>): Record<string, unknown> {
    return {
        id: payload.id ?? null,
        success: payload.success ?? null,
        pending: payload.pending ?? null,
        amount_cents: payload.amount_cents ?? null,
        currency: payload.currency ?? null,
        order: typeof payload.order === 'object' ? (payload.order as any)?.id : payload.order,
    };
}
