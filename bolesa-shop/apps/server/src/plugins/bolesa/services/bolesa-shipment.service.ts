import { Injectable, OnModuleInit } from '@nestjs/common';
import { HistoryEntryType, JobState } from '@vendure/common/lib/generated-types';
import {
    ChannelService,
    EventBus,
    Fulfillment,
    FulfillmentEvent,
    FulfillmentLine,
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
import { decideCreateAwbGate, isValidPersistedOrderId } from '../util/create-awb-gate';
import { minorToMajor } from '../util/money';
import {
    ACTIVE_CANCEL_JOB_STATES,
    ACTIVE_CREATE_JOB_STATES,
    CANCEL_AWB_JOB_RETRIES,
    CREATE_AWB_JOB_RETRIES,
    CancelJobEnqueueDecision,
    CreateJobEnqueueDecision,
    decideCancelJobEnqueue,
    decideCreateJobEnqueue,
    isExhaustedJobRecord,
    isLastJobAttempt,
} from '../util/outbox-recovery';
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
            process: async job => {
                try {
                    return await this.processCreateAwb(job.data);
                } catch (e) {
                    if (isLastJobAttempt(job)) {
                        await this.markCreateRetryExhausted(job.data).catch(err =>
                            Logger.error(
                                `markCreateRetryExhausted: ${(err as Error)?.message}`,
                                loggerCtx,
                            ),
                        );
                    }
                    throw e;
                }
            },
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
     * Save and JobQueue.add are not one DB transaction — recovery re-enqueues orphans.
     * Never persists a fabricated orderId; missing Order fails closed without an outbox row.
     */
    private async onFulfillmentCreated(event: FulfillmentEvent) {
        const fulfillment = event.entity;
        if (fulfillment.handlerCode !== BOLESA_FULFILLMENT_HANDLER_CODE) {
            return;
        }
        const ctx = event.ctx;
        const existing = await this.findByFulfillmentId(ctx, fulfillment.id);
        if (existing) {
            // Duplicate FulfillmentEvent: only re-enqueue when still awaiting create.
            if (existing.syncStatus === 'requested') {
                await this.ensureCreateAwbJobEnqueued(existing, { ignoreGracePeriod: true });
            }
            return;
        }

        const orderId = await this.resolveOrderIdForFulfillment(ctx, fulfillment.id);
        if (!isValidPersistedOrderId(orderId)) {
            const message =
                `Bolesa outbox skipped: could not resolve Order for fulfillment ${fulfillment.id}. ` +
                `No shipment row created (avoids indefinite retries on orderId=0).`;
            Logger.error(message, loggerCtx);
            await this.patchFulfillment(ctx, fulfillment.id, {
                bolesaSyncStatus: 'failed',
                bolesaLabelAvailability: 'unavailable',
            });
            return;
        }

        const shipmentKey = `f${fulfillment.id}`;
        const attempt = 1;
        const shipment = new BolesaShipment({
            fulfillmentId: fulfillment.id,
            orderId,
            channelId: ctx.channelId,
            shipmentKey,
            idempotencyKey: `${shipmentKey}-a${attempt}`,
            attempt,
            syncStatus: 'requested',
            labelAvailability: 'unavailable',
            codCollectionStatus: 'pending',
            codRemittanceStatus: 'unknown',
        });

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

        await this.ensureCreateAwbJobEnqueued(shipment, { ignoreGracePeriod: true });
    }

    /**
     * Resolve Order id via Fulfillment.orders, then FulfillmentLine → OrderLine.order.
     */
    async resolveOrderIdForFulfillment(ctx: RequestContext, fulfillmentId: ID): Promise<ID | null> {
        const withOrders = await this.connection.getRepository(ctx, Fulfillment).findOne({
            where: { id: fulfillmentId },
            relations: { orders: true },
        });
        const fromOrders = withOrders?.orders?.[0]?.id;
        if (isValidPersistedOrderId(fromOrders)) {
            return fromOrders!;
        }

        const line = await this.connection.getRepository(ctx, FulfillmentLine).findOne({
            where: { fulfillment: { id: fulfillmentId } },
            relations: { orderLine: { order: true } },
        });
        const fromLine = (line as any)?.orderLine?.order?.id ?? (line as any)?.orderLine?.orderId;
        if (isValidPersistedOrderId(fromLine)) {
            return fromLine;
        }
        return null;
    }

    /**
     * Enqueue `bolesa-create-awb` only when syncStatus is `requested` and no equivalent
     * active JobQueue row exists. Does not bump attempt / idempotencyKey.
     * Serializes concurrent recoveries via FOR UPDATE on the shipment row.
     */
    async ensureCreateAwbJobEnqueued(
        shipment: BolesaShipment,
        options?: { ignoreGracePeriod?: boolean },
    ): Promise<CreateJobEnqueueDecision> {
        const ctx = await this.ctxForChannel(shipment.channelId);
        return this.connection.withTransaction(ctx, async txCtx => {
            const locked = await this.lockShipmentForFulfillment(txCtx, shipment.fulfillmentId);
            if (!locked) {
                return 'skip_status';
            }
            const hasActive = await this.hasActiveCreateAwbJob(locked);
            const decision = decideCreateJobEnqueue({
                shipment: {
                    fulfillmentId: locked.fulfillmentId,
                    channelId: locked.channelId,
                    attempt: locked.attempt,
                    syncStatus: locked.syncStatus,
                    updatedAt: locked.updatedAt,
                },
                hasActiveEquivalentJob: hasActive,
                ignoreGracePeriod: options?.ignoreGracePeriod,
            });
            if (decision !== 'enqueue') {
                return decision;
            }
            await this.createQueue.add(
                {
                    fulfillmentId: locked.fulfillmentId,
                    channelId: locked.channelId,
                    attempt: locked.attempt,
                },
                { retries: CREATE_AWB_JOB_RETRIES },
            );
            return 'enqueue';
        });
    }

    /**
     * True when job_record has a PENDING/RUNNING/RETRYING create job for this
     * fulfillment+channel+attempt. Filters at the database using JSON text payload fields
     * (Vendure `job_record.data` is `text` storing JSON).
     */
    async hasActiveCreateAwbJob(
        shipment: Pick<BolesaShipment, 'fulfillmentId' | 'channelId' | 'attempt'>,
    ): Promise<boolean> {
        const rows: Array<{ id: number }> = await this.connection.rawConnection.query(
            `SELECT id FROM job_record
             WHERE "queueName" = $1
               AND state = ANY($2::text[])
               AND "isSettled" = false
               AND (data::json->>'fulfillmentId') = $3
               AND (data::json->>'channelId') = $4
               AND (data::json->>'attempt') = $5
             LIMIT 1`,
            [
                CREATE_AWB_QUEUE,
                [...ACTIVE_CREATE_JOB_STATES],
                String(shipment.fulfillmentId),
                String(shipment.channelId),
                String(shipment.attempt),
            ],
        );
        return rows.length > 0;
    }

    /**
     * True when a FAILED settled create job for this attempt has exhausted JobQueue retries
     * (`attempts > retries`). Used to stop unbounded orphan recovery.
     */
    async hasExhaustedCreateAwbJob(
        shipment: Pick<BolesaShipment, 'fulfillmentId' | 'channelId' | 'attempt'>,
    ): Promise<boolean> {
        const rows: Array<{ state: string; attempts: number; retries: number; isSettled: boolean }> =
            await this.connection.rawConnection.query(
                `SELECT state, attempts, retries, "isSettled"
                 FROM job_record
                 WHERE "queueName" = $1
                   AND state = $2
                   AND (data::json->>'fulfillmentId') = $3
                   AND (data::json->>'channelId') = $4
                   AND (data::json->>'attempt') = $5
                 ORDER BY id DESC
                 LIMIT 5`,
                [
                    CREATE_AWB_QUEUE,
                    JobState.FAILED,
                    String(shipment.fulfillmentId),
                    String(shipment.channelId),
                    String(shipment.attempt),
                ],
            );
        return rows.some(row => isExhaustedJobRecord(row));
    }

    /**
     * Mark outbox as `retry_exhausted` after JobQueue create attempts are spent.
     * Does not abandon; Admin retry restores `requested` with a new attempt/idempotency key.
     */
    async markCreateRetryExhausted(data: CreateAwbJobData): Promise<void> {
        const ctx = await this.ctxForChannel(data.channelId);
        await this.connection.withTransaction(ctx, async txCtx => {
            const shipment = await this.lockShipmentForFulfillment(txCtx, data.fulfillmentId);
            if (!shipment) {
                return;
            }
            if (shipment.syncStatus !== 'requested' && shipment.syncStatus !== 'awaiting_bolesa') {
                return;
            }
            if (Number(shipment.attempt) !== Number(data.attempt)) {
                return;
            }
            shipment.syncStatus = 'retry_exhausted';
            shipment.lastError =
                shipment.lastError ??
                `Create AWB JobQueue retries exhausted (attempt ${shipment.attempt})`;
            shipment.lastErrorAt = new Date();
            await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
            await this.patchFulfillment(txCtx, data.fulfillmentId, {
                bolesaSyncStatus: 'retry_exhausted',
            });
        });
    }

    /**
     * Recover orphaned `requested` outbox rows that have no active create job.
     * Exhausted FAILED jobs → `retry_exhausted` (no re-enqueue). Does not call Partner API.
     */
    async recoverOrphanedRequestedShipments(): Promise<{
        scanned: number;
        enqueued: number;
        skippedActive: number;
        skippedGrace: number;
        markedExhausted: number;
    }> {
        const baseCtx = await this.requestContextService.create({ apiType: 'admin' });
        const channels = await this.channelService.findAll(baseCtx);
        let scanned = 0;
        let enqueued = 0;
        let skippedActive = 0;
        let skippedGrace = 0;
        let markedExhausted = 0;

        for (const channel of channels.items) {
            const ctx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: channel,
            });
            const orphans = await this.connection.getRepository(ctx, BolesaShipment).find({
                where: {
                    channelId: channel.id,
                    syncStatus: 'requested',
                },
                order: { updatedAt: 'ASC' },
                take: 100,
            });
            for (const shipment of orphans) {
                scanned++;
                if (await this.hasActiveCreateAwbJob(shipment)) {
                    skippedActive++;
                    continue;
                }
                if (await this.hasExhaustedCreateAwbJob(shipment)) {
                    await this.markCreateRetryExhausted({
                        fulfillmentId: shipment.fulfillmentId,
                        channelId: shipment.channelId,
                        attempt: shipment.attempt,
                    });
                    markedExhausted++;
                    Logger.warn(
                        `Create retries exhausted for fulfillment ${shipment.fulfillmentId} attempt ${shipment.attempt}; marked retry_exhausted`,
                        loggerCtx,
                    );
                    continue;
                }
                const decision = await this.ensureCreateAwbJobEnqueued(shipment);
                if (decision === 'enqueue') {
                    enqueued++;
                    Logger.info(
                        `Recovered orphaned create job for fulfillment ${shipment.fulfillmentId} (attempt ${shipment.attempt})`,
                        loggerCtx,
                    );
                } else if (decision === 'skip_active_job') {
                    skippedActive++;
                } else if (decision === 'skip_grace') {
                    skippedGrace++;
                }
            }
        }

        return { scanned, enqueued, skippedActive, skippedGrace, markedExhausted };
    }

    /**
     * Enqueue cancel job when `cancel_requested` and no active equivalent cancel job exists.
     * Serializes concurrent recoveries via FOR UPDATE on the shipment row.
     */
    async ensureCancelAwbJobEnqueued(
        shipment: BolesaShipment,
        options?: { ignoreGracePeriod?: boolean; ignoreExhausted?: boolean },
    ): Promise<CancelJobEnqueueDecision> {
        if (!shipment.trackingNumber) {
            return 'skip_status';
        }
        const ctx = await this.ctxForChannel(shipment.channelId);
        return this.connection.withTransaction(ctx, async txCtx => {
            const locked = await this.lockShipmentForFulfillment(txCtx, shipment.fulfillmentId);
            if (!locked?.trackingNumber) {
                return 'skip_status';
            }
            const identity = {
                fulfillmentId: locked.fulfillmentId,
                channelId: locked.channelId,
                trackingNumber: locked.trackingNumber,
            };
            const hasActive = await this.hasActiveCancelAwbJob(identity);
            const hasExhausted = await this.hasExhaustedCancelAwbJob(identity);
            const decision = decideCancelJobEnqueue({
                shipment: {
                    ...identity,
                    syncStatus: locked.syncStatus,
                    updatedAt: locked.updatedAt,
                },
                hasActiveEquivalentJob: hasActive,
                hasExhaustedJob: hasExhausted,
                ignoreGracePeriod: options?.ignoreGracePeriod,
                ignoreExhausted: options?.ignoreExhausted,
            });
            if (decision !== 'enqueue') {
                return decision;
            }
            await this.cancelQueue.add(
                {
                    fulfillmentId: locked.fulfillmentId,
                    channelId: locked.channelId,
                    trackingNumber: locked.trackingNumber,
                    attempt: locked.attempt,
                },
                { retries: CANCEL_AWB_JOB_RETRIES },
            );
            return 'enqueue';
        });
    }

    async hasActiveCancelAwbJob(shipment: {
        fulfillmentId: ID;
        channelId: ID;
        trackingNumber: string;
    }): Promise<boolean> {
        const rows: Array<{ id: number }> = await this.connection.rawConnection.query(
            `SELECT id FROM job_record
             WHERE "queueName" = $1
               AND state = ANY($2::text[])
               AND "isSettled" = false
               AND (data::json->>'fulfillmentId') = $3
               AND (data::json->>'channelId') = $4
               AND (data::json->>'trackingNumber') = $5
             LIMIT 1`,
            [
                CANCEL_AWB_QUEUE,
                [...ACTIVE_CANCEL_JOB_STATES],
                String(shipment.fulfillmentId),
                String(shipment.channelId),
                String(shipment.trackingNumber),
            ],
        );
        return rows.length > 0;
    }

    async hasExhaustedCancelAwbJob(shipment: {
        fulfillmentId: ID;
        channelId: ID;
        trackingNumber: string;
    }): Promise<boolean> {
        const rows: Array<{ state: string; attempts: number; retries: number }> =
            await this.connection.rawConnection.query(
                `SELECT state, attempts, retries
                 FROM job_record
                 WHERE "queueName" = $1
                   AND state = $2
                   AND (data::json->>'fulfillmentId') = $3
                   AND (data::json->>'channelId') = $4
                   AND (data::json->>'trackingNumber') = $5
                 ORDER BY id DESC
                 LIMIT 5`,
                [
                    CANCEL_AWB_QUEUE,
                    JobState.FAILED,
                    String(shipment.fulfillmentId),
                    String(shipment.channelId),
                    String(shipment.trackingNumber),
                ],
            );
        return rows.some(row => isExhaustedJobRecord(row));
    }

    /**
     * Recover `cancel_requested` rows missing an active cancel job (crash between save and enqueue).
     * Does not cancel unrelated states. Does not call Partner API.
     */
    async recoverOrphanedCancelRequestedShipments(): Promise<{
        scanned: number;
        enqueued: number;
        skippedActive: number;
        skippedGrace: number;
        skippedExhausted: number;
    }> {
        const baseCtx = await this.requestContextService.create({ apiType: 'admin' });
        const channels = await this.channelService.findAll(baseCtx);
        let scanned = 0;
        let enqueued = 0;
        let skippedActive = 0;
        let skippedGrace = 0;
        let skippedExhausted = 0;

        for (const channel of channels.items) {
            const ctx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: channel,
            });
            const orphans = await this.connection.getRepository(ctx, BolesaShipment).find({
                where: {
                    channelId: channel.id,
                    syncStatus: 'cancel_requested',
                },
                order: { updatedAt: 'ASC' },
                take: 100,
            });
            for (const shipment of orphans) {
                scanned++;
                const decision = await this.ensureCancelAwbJobEnqueued(shipment);
                if (decision === 'enqueue') {
                    enqueued++;
                    Logger.info(
                        `Recovered orphaned cancel job for fulfillment ${shipment.fulfillmentId} TN=${shipment.trackingNumber}`,
                        loggerCtx,
                    );
                } else if (decision === 'skip_active_job') {
                    skippedActive++;
                } else if (decision === 'skip_grace') {
                    skippedGrace++;
                } else if (decision === 'skip_exhausted') {
                    skippedExhausted++;
                }
            }
        }

        return { scanned, enqueued, skippedActive, skippedGrace, skippedExhausted };
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
            await this.ensureCancelAwbJobEnqueued(shipment, {
                ignoreGracePeriod: true,
                ignoreExhausted: true,
            });
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
        // Admin retry: new attempt + idempotency key; restores eligibility from failed/retry_exhausted.
        shipment.attempt += 1;
        shipment.idempotencyKey = `${shipment.shipmentKey}-a${shipment.attempt}`;
        shipment.syncStatus = 'requested';
        shipment.lastError = null;
        await this.connection.getRepository(ctx, BolesaShipment).save(shipment);
        await this.createQueue.add(
            { fulfillmentId, channelId: ctx.channelId, attempt: shipment.attempt },
            { retries: CREATE_AWB_JOB_RETRIES },
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
        await this.ensureCancelAwbJobEnqueued(shipment, {
            ignoreGracePeriod: true,
            ignoreExhausted: true,
        });
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
        // Phase 1: lock inside a real transaction so FOR UPDATE is effective.
        // Partner HTTP runs outside the lock to avoid holding row locks for network RTT.
        const gate = await this.connection.withTransaction(ctx, async txCtx => {
            const shipment = await this.lockShipmentForFulfillment(txCtx, fulfillmentId);
            if (!shipment) {
                return { kind: 'missing' as const };
            }
            return decideCreateAwbGate(shipment);
        });

        if (gate.kind === 'missing') {
            Logger.warn(`No outbox row for fulfillment ${fulfillmentId}`, loggerCtx);
            return { ok: false };
        }
        if (gate.kind === 'done') {
            return { ok: true, trackingNumber: gate.trackingNumber };
        }
        if (gate.kind === 'terminal') {
            Logger.debug(
                `createAwb skipped for fulfillment ${fulfillmentId}: terminal/gated (${gate.reason})`,
                loggerCtx,
            );
            return { ok: false };
        }

        const conn = await this.connectionService.requireActive(ctx);
        const auth = this.connectionService.authFor(conn);

        // Pre-check / awaiting_bolesa: adopt existing AWB if Partner already has one.
        // awaiting_lookup never POSTs /awbs — lookup only.
        const pre = await this.client.findAwbsByMeta(auth, 'vendure_shipment_key', gate.shipmentKey);
        if (pre[0]?.trackingNumber) {
            return this.connection.withTransaction(ctx, async txCtx => {
                const shipment = await this.lockShipmentForFulfillment(txCtx, fulfillmentId);
                if (!shipment) {
                    return { ok: false };
                }
                const again = decideCreateAwbGate(shipment);
                if (again.kind === 'done') {
                    return { ok: true, trackingNumber: again.trackingNumber };
                }
                if (again.kind === 'terminal') {
                    return { ok: false };
                }
                await this.adoptAwb(txCtx, shipment, pre[0]);
                return { ok: true, trackingNumber: pre[0].trackingNumber };
            });
        }

        if (gate.kind === 'awaiting_lookup') {
            // Still queued at Partner; leave for reconcile — do not create again.
            return { ok: true };
        }

        if (!isValidPersistedOrderId(gate.orderId)) {
            await this.connection.withTransaction(ctx, async txCtx => {
                const shipment = await this.lockShipmentForFulfillment(txCtx, fulfillmentId);
                if (!shipment) {
                    return;
                }
                shipment.syncStatus = 'failed';
                shipment.lastError = `Invalid orderId on outbox row (${String(gate.orderId)})`;
                shipment.lastErrorAt = new Date();
                await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
                await this.patchFulfillment(txCtx, fulfillmentId, { bolesaSyncStatus: 'failed' });
            });
            return { ok: false };
        }

        const order = await this.orderService.findOne(ctx, gate.orderId, [
            'lines',
            'lines.productVariant',
            'shippingLines',
            'customer',
        ]);
        if (!order) {
            await this.connection.withTransaction(ctx, async txCtx => {
                const shipment = await this.lockShipmentForFulfillment(txCtx, fulfillmentId);
                if (!shipment) {
                    return;
                }
                shipment.syncStatus = 'failed';
                shipment.lastError = `Order ${gate.orderId} not found`;
                shipment.lastErrorAt = new Date();
                await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
                await this.patchFulfillment(txCtx, fulfillmentId, { bolesaSyncStatus: 'failed' });
            });
            return { ok: false };
        }

        // Snapshot fields needed for the Partner request (stable under attempt-scoped key)
        const inputShipment = {
            shipmentKey: gate.shipmentKey,
            idempotencyKey: gate.idempotencyKey,
            orderId: gate.orderId,
            attempt: gate.attempt,
        } as BolesaShipment;
        const input = this.buildCreateInput(ctx, order, inputShipment, conn);

        try {
            const result = await this.client.createAwb(auth, input, gate.idempotencyKey);
            return this.connection.withTransaction(ctx, async txCtx => {
                const shipment = await this.lockShipmentForFulfillment(txCtx, fulfillmentId);
                if (!shipment) {
                    return { ok: false };
                }
                const again = decideCreateAwbGate(shipment);
                if (again.kind === 'done') {
                    return { ok: true, trackingNumber: again.trackingNumber };
                }
                if (again.kind === 'terminal' || again.kind === 'awaiting_lookup') {
                    // cancel_requested / failed / already awaiting — do not overwrite with a late create
                    if (again.kind === 'awaiting_lookup' && result.status === 'queued') {
                        return { ok: true };
                    }
                    if (again.kind === 'terminal') {
                        return { ok: false };
                    }
                }
                if (result.status === 'queued') {
                    shipment.syncStatus = 'awaiting_bolesa';
                    shipment.lastError = null;
                    await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
                    await this.patchFulfillment(txCtx, fulfillmentId, {
                        bolesaSyncStatus: 'awaiting_bolesa',
                    });
                    return { ok: true };
                }
                const awb = result.awbs[0];
                if (!awb?.trackingNumber) {
                    throw new Error('Bolesa returned success without tracking_number');
                }
                await this.adoptAwb(txCtx, shipment, awb);
                return { ok: true, trackingNumber: awb.trackingNumber };
            });
        } catch (e: any) {
            if (e instanceof BolesaApiError) {
                if (e.isRetryable) {
                    await this.connection.withTransaction(ctx, async txCtx => {
                        const shipment = await this.lockShipmentForFulfillment(txCtx, fulfillmentId);
                        if (!shipment) {
                            return;
                        }
                        shipment.lastError = `${e.code}: ${e.message}`;
                        shipment.lastErrorAt = new Date();
                        await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
                    });
                    throw e;
                }
                if (e.isDefiniteFailure) {
                    await this.connection.withTransaction(ctx, async txCtx => {
                        const shipment = await this.lockShipmentForFulfillment(txCtx, fulfillmentId);
                        if (!shipment) {
                            return;
                        }
                        shipment.syncStatus = 'failed';
                        shipment.lastError = `${e.code}: ${e.message}`;
                        shipment.lastErrorAt = new Date();
                        await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
                        await this.patchFulfillment(txCtx, fulfillmentId, {
                            bolesaSyncStatus: 'failed',
                        });
                        await this.historyService.createHistoryEntryForOrder({
                            ctx: txCtx,
                            orderId: order.id,
                            type: HistoryEntryType.ORDER_NOTE,
                            data: {
                                note: `Bolesa AWB failed: ${e.code}: ${e.message}`,
                            },
                        });
                    });
                    return { ok: false };
                }
            }
            await this.connection.withTransaction(ctx, async txCtx => {
                const shipment = await this.lockShipmentForFulfillment(txCtx, fulfillmentId);
                if (!shipment) {
                    return;
                }
                shipment.lastError = e?.message ?? String(e);
                shipment.lastErrorAt = new Date();
                await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
            });
            throw e;
        }
    }

    private async lockShipmentForFulfillment(
        ctx: RequestContext,
        fulfillmentId: ID,
    ): Promise<BolesaShipment | null> {
        return this.connection
            .getRepository(ctx, BolesaShipment)
            .createQueryBuilder('s')
            .setLock('pessimistic_write')
            .where('s.fulfillmentId = :fulfillmentId AND s.channelId = :channelId', {
                fulfillmentId,
                channelId: ctx.channelId,
            })
            .getOne();
    }

    /**
     * Cancel processor: gate under FOR UPDATE → Partner HTTP outside txn → re-lock and commit.
     * Never cancels shipments that are no longer `cancel_requested`.
     */
    async processCancelAwb(data: CancelAwbJobData): Promise<{ ok: boolean }> {
        const ctx = await this.ctxForChannel(data.channelId);

        const gate = await this.connection.withTransaction(ctx, async txCtx => {
            const shipment = await this.lockShipmentForFulfillment(txCtx, data.fulfillmentId);
            if (!shipment?.trackingNumber) {
                return { kind: 'missing' as const };
            }
            if (shipment.syncStatus === 'canceled') {
                return { kind: 'done' as const };
            }
            if (shipment.syncStatus !== 'cancel_requested') {
                return { kind: 'wrong_state' as const, status: shipment.syncStatus };
            }
            return {
                kind: 'proceed' as const,
                trackingNumber: shipment.trackingNumber,
                shipmentKey: shipment.shipmentKey,
                attempt: shipment.attempt,
                orderId: shipment.orderId,
            };
        });

        if (gate.kind === 'done') {
            return { ok: true };
        }
        if (gate.kind !== 'proceed') {
            Logger.debug(
                `processCancelAwb skipped fulfillment ${data.fulfillmentId}: ${gate.kind}`,
                loggerCtx,
            );
            return { ok: false };
        }

        const conn = await this.connectionService.requireActive(ctx);
        const auth = this.connectionService.authFor(conn);
        const cancelKey = `cancel-${gate.shipmentKey}-a${gate.attempt}`;

        try {
            // Partner HTTP outside DB transaction / row lock.
            await this.client.cancelAwb(auth, gate.trackingNumber, cancelKey);
        } catch (e: any) {
            if (e instanceof BolesaApiError && e.code === 'awb_not_cancellable') {
                await this.connection.withTransaction(ctx, async txCtx => {
                    const shipment = await this.lockShipmentForFulfillment(txCtx, data.fulfillmentId);
                    if (!shipment || shipment.syncStatus !== 'cancel_requested') {
                        return;
                    }
                    shipment.lastError =
                        'Cancellation refused by Bolesa (in transit). Request return-to-origin.';
                    shipment.lastErrorAt = new Date();
                    await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
                });
                return { ok: false };
            }
            throw e;
        }

        return this.connection.withTransaction(ctx, async txCtx => {
            const shipment = await this.lockShipmentForFulfillment(txCtx, data.fulfillmentId);
            if (!shipment) {
                return { ok: false };
            }
            // Re-check after Partner response — do not overwrite unrelated states.
            if (shipment.syncStatus === 'canceled') {
                return { ok: true };
            }
            if (shipment.syncStatus !== 'cancel_requested') {
                Logger.warn(
                    `Late cancel response ignored for fulfillment ${data.fulfillmentId}: syncStatus=${shipment.syncStatus}`,
                    loggerCtx,
                );
                return { ok: false };
            }
            shipment.syncStatus = 'canceled';
            shipment.statusCode = 'CANCELED';
            shipment.codCollectionStatus = 'not_collected';
            await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
            await this.patchFulfillment(txCtx, data.fulfillmentId, {
                bolesaStatus: 'CANCELED',
                bolesaSyncStatus: 'canceled',
            });
            const transition = await this.orderService.transitionFulfillmentToState(
                txCtx,
                data.fulfillmentId,
                'Cancelled',
            );
            if ((transition as any).errorCode) {
                Logger.warn(
                    `Fulfillment cancel transition blocked: ${(transition as any).message}`,
                    loggerCtx,
                );
            }
            await this.cancelCodPaymentIfNeeded(txCtx, shipment.orderId);
            return { ok: true };
        });
    }

    async applyObservedStatus(data: ApplyStatusJobData): Promise<void> {
        const ctx = await this.ctxForChannel(data.channelId);
        const conn = await this.connectionService.requireActive(ctx);
        const awb = await this.client.getAwb(this.connectionService.authFor(conn), data.trackingNumber);
        if (!awb?.statusCode) {
            return;
        }
        const observedAt = data.observedAt ? new Date(data.observedAt) : new Date();

        await this.connection.withTransaction(ctx, async txCtx => {
            const shipment = await this.connection
                .getRepository(txCtx, BolesaShipment)
                .createQueryBuilder('s')
                .setLock('pessimistic_write')
                .where('s.trackingNumber = :tn AND s.channelId = :channelId', {
                    tn: data.trackingNumber,
                    channelId: txCtx.channelId,
                })
                .getOne();
            if (!shipment) {
                return;
            }
            if (shouldIgnoreAsStale(awb.statusCode!, shipment.statusCode, observedAt, shipment.lastStatusAt)) {
                return;
            }

            shipment.statusCode = awb.statusCode!;
            shipment.lastStatusAt = observedAt;
            shipment.rawLastPayload = awb;
            if (awb.labelUrl) {
                shipment.labelUrl = awb.labelUrl;
                shipment.labelAvailability = 'url_present';
            }
            await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
            await this.patchFulfillment(txCtx, shipment.fulfillmentId, {
                bolesaStatus: awb.statusCode,
                bolesaLabelAvailability: shipment.labelAvailability,
            });

            const target = mapBolesaStatusToFulfillmentTarget(awb.statusCode!);
            if (target === 'Delivered') {
                await this.settleCodPaymentIfNeeded(txCtx, shipment.orderId);
                shipment.codCollectionStatus = 'collected';
                await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
                await this.orderService.transitionFulfillmentToState(txCtx, shipment.fulfillmentId, 'Delivered');
            } else if (target === 'Shipped') {
                await this.orderService.transitionFulfillmentToState(txCtx, shipment.fulfillmentId, 'Shipped');
            } else if (target === 'Cancelled') {
                shipment.syncStatus = 'canceled';
                shipment.codCollectionStatus = 'not_collected';
                await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
                await this.cancelCodPaymentIfNeeded(txCtx, shipment.orderId);
                await this.orderService.transitionFulfillmentToState(txCtx, shipment.fulfillmentId, 'Cancelled');
            } else if (target === 'Returned') {
                shipment.codCollectionStatus = 'not_collected';
                await this.connection.getRepository(txCtx, BolesaShipment).save(shipment);
                await this.cancelCodPaymentIfNeeded(txCtx, shipment.orderId);
                await this.orderService.transitionFulfillmentToState(txCtx, shipment.fulfillmentId, 'Returned');
            }
        });
    }

    async reconcileOpenShipments(): Promise<{
        checked: number;
        recovered: number;
        recoveryScanned: number;
        cancelRecovered: number;
        cancelRecoveryScanned: number;
        markedExhausted: number;
    }> {
        // Outbox recovery does not call Partner API — run even when connection is missing.
        const recovery = await this.recoverOrphanedRequestedShipments();
        const cancelRecovery = await this.recoverOrphanedCancelRequestedShipments();

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
        return {
            checked,
            recovered: recovery.enqueued,
            recoveryScanned: recovery.scanned,
            cancelRecovered: cancelRecovery.enqueued,
            cancelRecoveryScanned: cancelRecovery.scanned,
            markedExhausted: recovery.markedExhausted,
        };
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
