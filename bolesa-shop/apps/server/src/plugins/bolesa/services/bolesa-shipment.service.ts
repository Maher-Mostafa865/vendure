import { Injectable, OnModuleInit } from '@nestjs/common';
import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import {
    ChannelService,
    EventBus,
    Fulfillment,
    FulfillmentEvent,
    HistoryService,
    ID,
    JobQueue,
    JobQueueService,
    Logger,
    Order,
    OrderPlacedEvent,
    OrderService,
    OrderStateTransitionEvent,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { In } from 'typeorm';

import {
    BOLESA_COD_HANDLER_CODE,
    BOLESA_FULFILLMENT_HANDLER_CODE,
    CANCEL_AWB_QUEUE,
    CREATE_AWB_QUEUE,
    loggerCtx,
} from '../constants';
import { BolesaShipment } from '../entities/bolesa-shipment.entity';
import {
    ApplyStatusJobData,
    BolesaCreateAwbInput,
    CancelAwbJobData,
    CreateAwbJobData,
    PaymentPreference,
    PersistedBolesaQuote,
} from '../types';
import { minorToMajor } from '../util/money';
import {
    isTerminalBolesaStatus,
    mapBolesaStatusToFulfillmentTarget,
    shouldIgnoreAsStale,
} from '../util/status-map';
import { BolesaApiError, BolesaClient } from './bolesa-client.service';
import { BolesaConnectionService } from './bolesa-connection.service';
import { BolesaRateService } from './bolesa-rate.service';

@Injectable()
export class BolesaShipmentService implements OnModuleInit {
    private createQueue: JobQueue<CreateAwbJobData>;
    private cancelQueue: JobQueue<CancelAwbJobData>;

    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private eventBus: EventBus,
        private jobQueueService: JobQueueService,
        private client: BolesaClient,
        private connectionService: BolesaConnectionService,
        private rateService: BolesaRateService,
        private orderService: OrderService,
        private historyService: HistoryService,
        private requestContextService: RequestContextService,
    ) {}

    async onModuleInit() {
        this.createQueue = await this.jobQueueService.createQueue({
            name: CREATE_AWB_QUEUE,
            process: async job => this.processCreateAwb(job.data),
        });
        this.cancelQueue = await this.jobQueueService.createQueue({
            name: CANCEL_AWB_QUEUE,
            process: async job => this.processCancelAwb(job.data),
        });

        this.eventBus.ofType(FulfillmentEvent).subscribe(event => {
            void this.onFulfillmentCreated(event).catch(err =>
                Logger.error(`onFulfillmentCreated: ${err?.message}`, loggerCtx),
            );
        });

        this.eventBus.ofType(OrderPlacedEvent).subscribe(event => {
            void this.persistQuoteOnOrderPlaced(event).catch(err =>
                Logger.error(`persistQuoteOnOrderPlaced: ${err?.message}`, loggerCtx),
            );
        });

        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(event => {
            if (event.toState === 'Cancelled') {
                void this.onOrderCancelled(event).catch(err =>
                    Logger.error(`onOrderCancelled: ${err?.message}`, loggerCtx),
                );
            }
        });
    }

    async findByFulfillmentId(ctx: RequestContext, fulfillmentId: ID): Promise<BolesaShipment | null> {
        return this.connection.getRepository(ctx, BolesaShipment).findOne({
            where: { fulfillmentId, channelId: ctx.channelId },
            relations: { channels: true },
        });
    }

    async findByTracking(ctx: RequestContext, trackingNumber: string): Promise<BolesaShipment | null> {
        return this.connection.getRepository(ctx, BolesaShipment).findOne({
            where: { trackingNumber, channelId: ctx.channelId },
        });
    }

    async listForChannel(
        ctx: RequestContext,
        options?: { syncStatus?: string; take?: number; skip?: number },
    ): Promise<{ items: BolesaShipment[]; totalItems: number }> {
        const qb = this.connection
            .getRepository(ctx, BolesaShipment)
            .createQueryBuilder('s')
            .where('s.channelId = :channelId', { channelId: ctx.channelId })
            .orderBy('s.updatedAt', 'DESC');
        if (options?.syncStatus) {
            qb.andWhere('s.syncStatus = :syncStatus', { syncStatus: options.syncStatus });
        }
        const take = options?.take ?? 50;
        const skip = options?.skip ?? 0;
        const [items, totalItems] = await qb.take(take).skip(skip).getManyAndCount();
        return { items, totalItems };
    }

    /**
     * After commit: create outbox row (no HTTP), then enqueue AWB job.
     */
    private async onFulfillmentCreated(event: FulfillmentEvent) {
        const fulfillment = event.entity;
        if (fulfillment.handlerCode !== BOLESA_FULFILLMENT_HANDLER_CODE) {
            return;
        }
        const ctx = event.ctx;
        const existing = await this.findByFulfillmentId(ctx, fulfillment.id);
        if (existing) {
            await this.createQueue.add(
                { fulfillmentId: fulfillment.id, channelId: ctx.channelId, attempt: existing.attempt },
                { retries: 5 },
            );
            return;
        }

        const shipmentKey = `f${fulfillment.id}`;
        const attempt = 1;
        const shipment = new BolesaShipment({
            fulfillmentId: fulfillment.id,
            orderId: '0',
            channelId: ctx.channelId,
            shipmentKey,
            idempotencyKey: `${shipmentKey}-a${attempt}`,
            attempt,
            syncStatus: 'requested',
            labelAvailability: 'unavailable',
            codCollectionStatus: 'pending',
            codRemittanceStatus: 'unknown',
        });

        // Resolve order id from fulfillment lines if available
        const withOrders = await this.connection.getRepository(ctx, Fulfillment).findOne({
            where: { id: fulfillment.id },
            relations: { orders: true },
        });
        if (withOrders?.orders?.[0]) {
            shipment.orderId = withOrders.orders[0].id;
        }

        await this.channelService.assignToCurrentChannel(shipment, ctx);
        await this.connection.getRepository(ctx, BolesaShipment).save(shipment);

        await this.connection.getRepository(ctx, Fulfillment).update(fulfillment.id, {
            customFields: {
                ...(fulfillment.customFields as any),
                bolesaSyncStatus: 'requested',
                bolesaShipmentKey: shipmentKey,
                bolesaLabelAvailability: 'unavailable',
            },
        } as any);

        await this.createQueue.add(
            { fulfillmentId: fulfillment.id, channelId: ctx.channelId, attempt },
            { retries: 5 },
        );
    }

    private async persistQuoteOnOrderPlaced(event: OrderPlacedEvent) {
        const { ctx, order } = event;
        try {
            await this.connectionService.requireActive(ctx);
        } catch {
            return;
        }
        const preference = ((order as any).customFields?.paymentPreference ?? 'prepaid') as PaymentPreference;
        const services = await this.rateService.getOptionsForOrder(ctx, order, preference);
        const conn = await this.connectionService.requireActive(ctx);
        // Prefer shipping line metadata slug if present
        const metaSlug =
            (order.shippingLines?.[0] as any)?.shippingMethod?.calculator?.args?.find(
                (a: any) => a.name === 'carrierServiceSlug',
            )?.value ?? conn.defaultServiceSlug ?? 'auto';
        const option = this.rateService.pickOption(services, metaSlug);
        if (!option) {
            return;
        }
        const built = this.rateService.buildQuote(
            option,
            preference,
            conn.markupPercent ?? 0,
            conn.codFeeMode ?? 'absorb',
            ctx.channel.defaultCurrencyCode,
        );
        if (!built) {
            return;
        }
        await this.connection.getRepository(ctx, Order).update(order.id, {
            customFields: {
                ...(order.customFields as any),
                bolesaQuote: JSON.stringify(built.quote),
            },
        } as any);
    }

    private async onOrderCancelled(event: OrderStateTransitionEvent) {
        const ctx = event.ctx;
        const order = await this.orderService.findOne(ctx, event.order.id, [
            'fulfillments',
            'fulfillments.orders',
        ]);
        if (!order?.fulfillments?.length) {
            return;
        }
        for (const fulfillment of order.fulfillments) {
            if (fulfillment.handlerCode !== BOLESA_FULFILLMENT_HANDLER_CODE) {
                continue;
            }
            const shipment = await this.findByFulfillmentId(ctx, fulfillment.id);
            if (!shipment?.trackingNumber) {
                continue;
            }
            if (isTerminalBolesaStatus(shipment.statusCode)) {
                continue;
            }
            shipment.syncStatus = 'cancel_requested';
            await this.connection.getRepository(ctx, BolesaShipment).save(shipment);
            await this.cancelQueue.add(
                {
                    fulfillmentId: fulfillment.id,
                    channelId: ctx.channelId,
                    trackingNumber: shipment.trackingNumber,
                },
                { retries: 5 },
            );
        }
    }

    async retryShipment(ctx: RequestContext, fulfillmentId: ID): Promise<BolesaShipment> {
        const shipment = await this.findByFulfillmentId(ctx, fulfillmentId);
        if (!shipment) {
            throw new UserInputError(`No Bolesa shipment for fulfillment ${fulfillmentId}`);
        }
        if (shipment.syncStatus === 'created' && shipment.trackingNumber) {
            return shipment;
        }
        // Pre-check before bumping attempt
        const conn = await this.connectionService.requireActive(ctx);
        const auth = this.connectionService.authFor(conn);
        const existing = await this.client.findAwbsByMeta(auth, 'vendure_shipment_key', shipment.shipmentKey);
        if (existing[0]?.trackingNumber) {
            await this.adoptAwb(ctx, shipment, existing[0]);
            return (await this.findByFulfillmentId(ctx, fulfillmentId))!;
        }
        shipment.attempt += 1;
        shipment.idempotencyKey = `${shipment.shipmentKey}-a${shipment.attempt}`;
        shipment.syncStatus = 'requested';
        shipment.lastError = null;
        await this.connection.getRepository(ctx, BolesaShipment).save(shipment);
        await this.createQueue.add(
            { fulfillmentId, channelId: ctx.channelId, attempt: shipment.attempt },
            { retries: 5 },
        );
        return shipment;
    }

    async abandonShipment(ctx: RequestContext, fulfillmentId: ID): Promise<Fulfillment> {
        const shipment = await this.findByFulfillmentId(ctx, fulfillmentId);
        if (!shipment) {
            throw new UserInputError(`No Bolesa shipment for fulfillment ${fulfillmentId}`);
        }
        if (shipment.trackingNumber && !isTerminalBolesaStatus(shipment.statusCode)) {
            throw new UserInputError(
                'Cannot abandon a live Bolesa AWB. Cancel the shipment first, or wait for a terminal status.',
            );
        }
        shipment.syncStatus = 'abandoned';
        await this.connection.getRepository(ctx, BolesaShipment).save(shipment);
        const result = await this.orderService.transitionFulfillmentToState(ctx, fulfillmentId, 'Cancelled');
        if ((result as any).errorCode) {
            throw new UserInputError((result as any).message ?? 'Could not cancel fulfillment');
        }
        return result as Fulfillment;
    }

    async requestCancel(ctx: RequestContext, fulfillmentId: ID): Promise<BolesaShipment> {
        const shipment = await this.findByFulfillmentId(ctx, fulfillmentId);
        if (!shipment?.trackingNumber) {
            throw new UserInputError('Shipment has no tracking number yet');
        }
        shipment.syncStatus = 'cancel_requested';
        await this.connection.getRepository(ctx, BolesaShipment).save(shipment);
        await this.cancelQueue.add(
            {
                fulfillmentId,
                channelId: ctx.channelId,
                trackingNumber: shipment.trackingNumber,
            },
            { retries: 5 },
        );
        return shipment;
    }

    async processCreateAwb(data: CreateAwbJobData): Promise<{ ok: boolean; trackingNumber?: string }> {
        const ctx = await this.ctxForChannel(data.channelId);
        return this.createAwbForFulfillment(ctx, data.fulfillmentId);
    }

    private async ctxForChannel(channelId: ID): Promise<RequestContext> {
        const baseCtx = await this.requestContextService.create({ apiType: 'admin' });
        const channels = await this.channelService.findAll(baseCtx);
        const channel = channels.items.find(c => String(c.id) === String(channelId));
        if (!channel) {
            throw new Error(`Channel ${channelId} not found`);
        }
        return this.requestContextService.create({ apiType: 'admin', channelOrToken: channel });
    }

    async createAwbForFulfillment(
        ctx: RequestContext,
        fulfillmentId: ID,
    ): Promise<{ ok: boolean; trackingNumber?: string }> {
        const repo = this.connection.getRepository(ctx, BolesaShipment);
        const shipment = await repo
            .createQueryBuilder('s')
            .setLock('pessimistic_write')
            .where('s.fulfillmentId = :fulfillmentId AND s.channelId = :channelId', {
                fulfillmentId,
                channelId: ctx.channelId,
            })
            .getOne();

        if (!shipment) {
            Logger.warn(`No outbox row for fulfillment ${fulfillmentId}`, loggerCtx);
            return { ok: false };
        }
        if (shipment.syncStatus === 'created' && shipment.trackingNumber) {
            return { ok: true, trackingNumber: shipment.trackingNumber };
        }
        if (shipment.syncStatus === 'abandoned' || shipment.syncStatus === 'canceled') {
            return { ok: false };
        }

        const conn = await this.connectionService.requireActive(ctx);
        const auth = this.connectionService.authFor(conn);

        // Pre-check: adopt existing AWB if any
        const pre = await this.client.findAwbsByMeta(auth, 'vendure_shipment_key', shipment.shipmentKey);
        if (pre[0]?.trackingNumber) {
            await this.adoptAwb(ctx, shipment, pre[0]);
            return { ok: true, trackingNumber: pre[0].trackingNumber };
        }

        const order = await this.orderService.findOne(ctx, shipment.orderId, [
            'lines',
            'lines.productVariant',
            'shippingLines',
            'customer',
        ]);
        if (!order) {
            throw new Error(`Order ${shipment.orderId} not found`);
        }

        const input = this.buildCreateInput(ctx, order, shipment, conn);
        try {
            const result = await this.client.createAwb(auth, input, shipment.idempotencyKey);
            if (result.status === 'queued') {
                shipment.syncStatus = 'awaiting_bolesa';
                shipment.lastError = null;
                await repo.save(shipment);
                await this.patchFulfillment(ctx, fulfillmentId, {
                    bolesaSyncStatus: 'awaiting_bolesa',
                });
                return { ok: true };
            }
            const awb = result.awbs[0];
            if (!awb?.trackingNumber) {
                throw new Error('Bolesa returned success without tracking_number');
            }
            await this.adoptAwb(ctx, shipment, awb);
            return { ok: true, trackingNumber: awb.trackingNumber };
        } catch (e: any) {
            if (e instanceof BolesaApiError) {
                if (e.status === 409 || e.status >= 500) {
                    // Retryable — rethrow so JobQueue retries with same idempotency key
                    shipment.lastError = `${e.code}: ${e.message}`;
                    shipment.lastErrorAt = new Date();
                    await repo.save(shipment);
                    throw e;
                }
                // Definite 4xx — mark failed, do not retry (cached 422 for 24h)
                shipment.syncStatus = 'failed';
                shipment.lastError = `${e.code}: ${e.message}`;
                shipment.lastErrorAt = new Date();
                await repo.save(shipment);
                await this.patchFulfillment(ctx, fulfillmentId, {
                    bolesaSyncStatus: 'failed',
                });
                await this.historyService.createHistoryEntryForOrder({
                    ctx,
                    orderId: order.id,
                    type: HistoryEntryType.ORDER_NOTE,
                    data: {
                        note: `Bolesa AWB failed: ${e.code}: ${e.message}`,
                    },
                });
                return { ok: false };
            }
            shipment.lastError = e?.message ?? String(e);
            shipment.lastErrorAt = new Date();
            await repo.save(shipment);
            throw e;
        }
    }

    async processCancelAwb(data: CancelAwbJobData): Promise<{ ok: boolean }> {
        const ctx = await this.ctxForChannel(data.channelId);
        const shipment = await this.findByFulfillmentId(ctx, data.fulfillmentId);
        if (!shipment?.trackingNumber) {
            return { ok: false };
        }
        const conn = await this.connectionService.requireActive(ctx);
        const auth = this.connectionService.authFor(conn);
        const cancelKey = `cancel-${shipment.shipmentKey}-a${shipment.attempt}`;
        try {
            await this.client.cancelAwb(auth, shipment.trackingNumber, cancelKey);
            shipment.syncStatus = 'canceled';
            shipment.statusCode = 'CANCELED';
            shipment.codCollectionStatus = 'not_collected';
            await this.connection.getRepository(ctx, BolesaShipment).save(shipment);
            await this.patchFulfillment(ctx, data.fulfillmentId, {
                bolesaStatus: 'CANCELED',
                bolesaSyncStatus: 'canceled',
            });
            const transition = await this.orderService.transitionFulfillmentToState(
                ctx,
                data.fulfillmentId,
                'Cancelled',
            );
            if ((transition as any).errorCode) {
                Logger.warn(
                    `Fulfillment cancel transition blocked: ${(transition as any).message}`,
                    loggerCtx,
                );
            }
            // Cancel COD payment if still Authorized
            await this.cancelCodPaymentIfNeeded(ctx, shipment.orderId);
            return { ok: true };
        } catch (e: any) {
            if (e instanceof BolesaApiError && e.code === 'awb_not_cancellable') {
                shipment.lastError = 'Cancellation refused by Bolesa (in transit). Request return-to-origin.';
                shipment.lastErrorAt = new Date();
                await this.connection.getRepository(ctx, BolesaShipment).save(shipment);
                return { ok: false };
            }
            throw e;
        }
    }

    async applyObservedStatus(data: ApplyStatusJobData): Promise<void> {
        const ctx = await this.ctxForChannel(data.channelId);
        const repo = this.connection.getRepository(ctx, BolesaShipment);
        const shipment = await repo
            .createQueryBuilder('s')
            .setLock('pessimistic_write')
            .where('s.trackingNumber = :tn AND s.channelId = :channelId', {
                tn: data.trackingNumber,
                channelId: ctx.channelId,
            })
            .getOne();
        if (!shipment) {
            return;
        }

        const conn = await this.connectionService.requireActive(ctx);
        const awb = await this.client.getAwb(this.connectionService.authFor(conn), data.trackingNumber);
        if (!awb?.statusCode) {
            return;
        }
        const observedAt = data.observedAt ? new Date(data.observedAt) : new Date();
        if (shouldIgnoreAsStale(awb.statusCode, shipment.statusCode, observedAt, shipment.lastStatusAt)) {
            return;
        }

        shipment.statusCode = awb.statusCode;
        shipment.lastStatusAt = observedAt;
        shipment.rawLastPayload = awb;
        if (awb.labelUrl) {
            shipment.labelUrl = awb.labelUrl;
            shipment.labelAvailability = 'url_present';
        }
        await repo.save(shipment);
        await this.patchFulfillment(ctx, shipment.fulfillmentId, {
            bolesaStatus: awb.statusCode,
            bolesaLabelAvailability: shipment.labelAvailability,
        });

        const target = mapBolesaStatusToFulfillmentTarget(awb.statusCode);
        if (target === 'Delivered') {
            await this.settleCodPaymentIfNeeded(ctx, shipment.orderId);
            shipment.codCollectionStatus = 'collected';
            await repo.save(shipment);
            await this.orderService.transitionFulfillmentToState(ctx, shipment.fulfillmentId, 'Delivered');
        } else if (target === 'Shipped') {
            await this.orderService.transitionFulfillmentToState(ctx, shipment.fulfillmentId, 'Shipped');
        } else if (target === 'Cancelled') {
            shipment.syncStatus = 'canceled';
            shipment.codCollectionStatus = 'not_collected';
            await repo.save(shipment);
            await this.cancelCodPaymentIfNeeded(ctx, shipment.orderId);
            await this.orderService.transitionFulfillmentToState(ctx, shipment.fulfillmentId, 'Cancelled');
        } else if (target === 'Returned') {
            shipment.codCollectionStatus = 'not_collected';
            await repo.save(shipment);
            await this.cancelCodPaymentIfNeeded(ctx, shipment.orderId);
            await this.orderService.transitionFulfillmentToState(ctx, shipment.fulfillmentId, 'Returned');
        }
    }

    async reconcileOpenShipments(): Promise<{ checked: number }> {
        const baseCtx = await this.requestContextService.create({ apiType: 'admin' });
        const channels = await this.channelService.findAll(baseCtx);
        let checked = 0;
        for (const channel of channels.items) {
            const ctx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: channel,
            });
            let conn;
            try {
                conn = await this.connectionService.requireActive(ctx);
            } catch {
                continue;
            }
            const open = await this.connection.getRepository(ctx, BolesaShipment).find({
                where: {
                    channelId: channel.id,
                    syncStatus: In(['created', 'awaiting_bolesa', 'cancel_requested']),
                },
                take: 100,
            });
            for (const shipment of open) {
                if (!shipment.trackingNumber && shipment.syncStatus === 'awaiting_bolesa') {
                    const found = await this.client.findAwbsByMeta(
                        this.connectionService.authFor(conn),
                        'vendure_shipment_key',
                        shipment.shipmentKey,
                    );
                    if (found[0]) {
                        await this.adoptAwb(ctx, shipment, found[0]);
                        checked++;
                        continue;
                    }
                }
                if (shipment.trackingNumber && !isTerminalBolesaStatus(shipment.statusCode)) {
                    await this.applyObservedStatus({
                        channelId: channel.id,
                        trackingNumber: shipment.trackingNumber,
                    });
                    checked++;
                }
            }
        }
        return { checked };
    }

    private async adoptAwb(ctx: RequestContext, shipment: BolesaShipment, awb: {
        trackingNumber: string;
        awbReference?: string;
        statusCode?: string;
        labelUrl?: string | null;
        codAmount?: number;
        issuingFees?: unknown;
        carrierServiceSlug?: string;
    }) {
        shipment.trackingNumber = awb.trackingNumber;
        shipment.awbReference = awb.awbReference ?? null;
        shipment.statusCode = awb.statusCode ?? 'READY FOR SHIPMENT';
        shipment.carrierServiceSlug = awb.carrierServiceSlug ?? shipment.carrierServiceSlug;
        shipment.codAmount = awb.codAmount ?? null;
        shipment.issuingFees = awb.issuingFees ?? null;
        shipment.syncStatus = 'created';
        shipment.lastError = null;
        shipment.lastStatusAt = new Date();
        // Phase 0: label_url may be private S3 (403). Never claim download works.
        if (awb.labelUrl) {
            shipment.labelUrl = awb.labelUrl;
            shipment.labelAvailability = 'url_present';
        } else {
            shipment.labelAvailability = 'unavailable';
        }
        await this.connection.getRepository(ctx, BolesaShipment).save(shipment);

        const fulfillment = await this.connection.getRepository(ctx, Fulfillment).findOne({
            where: { id: shipment.fulfillmentId },
        });
        if (fulfillment) {
            fulfillment.trackingCode = awb.trackingNumber;
            (fulfillment as any).customFields = {
                ...((fulfillment as any).customFields ?? {}),
                bolesaTrackingNumber: awb.trackingNumber,
                bolesaStatus: shipment.statusCode,
                bolesaSyncStatus: 'created',
                bolesaLabelAvailability: shipment.labelAvailability,
                bolesaShipmentKey: shipment.shipmentKey,
            };
            await this.connection.getRepository(ctx, Fulfillment).save(fulfillment);
        }

        await this.historyService.createHistoryEntryForOrder({
            ctx,
            orderId: shipment.orderId,
            type: HistoryEntryType.ORDER_NOTE,
            data: {
                note: `Bolesa AWB created: ${awb.trackingNumber} (label: ${shipment.labelAvailability})`,
            },
        });
    }

    private buildCreateInput(
        ctx: RequestContext,
        order: Order,
        shipment: BolesaShipment,
        conn: Awaited<ReturnType<BolesaConnectionService['requireActive']>>,
    ): BolesaCreateAwbInput {
        const preference = ((order as any).customFields?.paymentPreference ?? 'prepaid') as PaymentPreference;
        let quote: PersistedBolesaQuote | null = null;
        try {
            const raw = (order as any).customFields?.bolesaQuote;
            quote = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        } catch {
            quote = null;
        }
        const serviceSlug =
            quote?.serviceSlug ?? conn.defaultServiceSlug ?? 'default';
        const shipper = conn.shipperAddress ?? {};
        const consigneeHash = (order.shippingAddress as any)?.customFields?.bolesaCityHash;
        const weightKg = Math.max(
            0.01,
            order.lines.reduce((sum, l) => {
                const w = Number((l.productVariant as any)?.customFields?.weightKg ?? 1);
                return sum + w * l.quantity;
            }, 0),
        );
        const input: BolesaCreateAwbInput = {
            orderNumber: order.code,
            carrierServiceSlug: serviceSlug,
            shipmentType: 'domestic',
            shipmentOperation: 'ship',
            shipmentCategory: conn.shipmentCategory ?? 'dry',
            paymentType: preference === 'cod' ? 'cod' : 'cc',
            weightKg,
            shipper: {
                name: String(shipper.name ?? 'Shipper'),
                phone: String(shipper.phone ?? '0000000000'),
                country_code: String(shipper.country_code ?? 'EG'),
                resolution_hash: String(shipper.resolution_hash ?? ''),
                address_line: String(shipper.address_line ?? ''),
                email: shipper.email ? String(shipper.email) : undefined,
                company_name: shipper.company_name ? String(shipper.company_name) : undefined,
            },
            consignee: {
                name: order.shippingAddress?.fullName ?? 'Customer',
                phone: order.shippingAddress?.phoneNumber ?? '0000000000',
                country_code: order.shippingAddress?.countryCode ?? 'EG',
                resolution_hash: String(consigneeHash ?? ''),
                address_line:
                    [order.shippingAddress?.streetLine1, order.shippingAddress?.streetLine2]
                        .filter(Boolean)
                        .join(', ') || 'Address',
                email: order.customer?.emailAddress,
            },
            description: `Order ${order.code}`,
            meta: {
                vendure_shipment_key: shipment.shipmentKey,
                vendure_order_code: order.code,
                vendure_channel: String(ctx.channelId),
            },
            parcels: order.lines.map(l => ({
                actual_weight: Number((l.productVariant as any)?.customFields?.weightKg ?? 1) * l.quantity,
            })),
        };
        if (preference === 'cod') {
            // Full amount customer owes including shipping (Vendure minor → EGP major)
            input.codAmount = minorToMajor(order.totalWithTax);
        }
        return input;
    }

    private async patchFulfillment(
        ctx: RequestContext,
        fulfillmentId: ID,
        fields: Record<string, unknown>,
    ) {
        const fulfillment = await this.connection.getRepository(ctx, Fulfillment).findOne({
            where: { id: fulfillmentId },
        });
        if (!fulfillment) {
            return;
        }
        await this.connection.getRepository(ctx, Fulfillment).update(fulfillmentId, {
            customFields: {
                ...(fulfillment.customFields as any),
                ...fields,
            },
        } as any);
    }

    private isBolesaCodPayment(payment: { method: string; metadata?: any }): boolean {
        return (
            payment.metadata?.method === 'bolesa-cod' ||
            payment.method === BOLESA_COD_HANDLER_CODE ||
            payment.method?.includes('bolesa-cod')
        );
    }

    private async settleCodPaymentIfNeeded(ctx: RequestContext, orderId: ID) {
        const order = await this.orderService.findOne(ctx, orderId, ['payments']);
        if (!order?.payments) {
            return;
        }
        for (const payment of order.payments) {
            if (this.isBolesaCodPayment(payment) && payment.state === 'Authorized') {
                await this.orderService.settlePayment(ctx, payment.id);
            }
        }
    }

    private async cancelCodPaymentIfNeeded(ctx: RequestContext, orderId: ID) {
        const order = await this.orderService.findOne(ctx, orderId, ['payments']);
        if (!order?.payments) {
            return;
        }
        for (const payment of order.payments) {
            if (this.isBolesaCodPayment(payment) && payment.state === 'Authorized') {
                await this.orderService.cancelPayment(ctx, payment.id);
            }
        }
    }
}
