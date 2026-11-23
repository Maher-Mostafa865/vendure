import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, OrderService, RequestContext, Transaction, UserInputError } from '@vendure/core';

import { bolesaConnectionPermission, bolesaShipmentPermission } from '../permissions';
import { BolesaConnectionService, UpdateBolesaConnectionInput } from '../services/bolesa-connection.service';
import { BolesaRateService } from '../services/bolesa-rate.service';
import { BolesaShipmentService } from '../services/bolesa-shipment.service';

@Resolver()
export class BolesaAdminResolver {
    constructor(
        private connectionService: BolesaConnectionService,
        private shipmentService: BolesaShipmentService,
        private rateService: BolesaRateService,
        private orderService: OrderService,
    ) {}

    @Query()
    @Allow(bolesaConnectionPermission.Read)
    async bolesaConnection(@Ctx() ctx: RequestContext) {
        const conn = await this.connectionService.getForChannel(ctx);
        return this.connectionService.toPublicView(conn);
    }

    @Query()
    @Allow(bolesaConnectionPermission.Read)
    async bolesaAccountServices(@Ctx() ctx: RequestContext) {
        return this.connectionService.listAccountServices(ctx);
    }

    @Query()
    @Allow(bolesaShipmentPermission.Read)
    async bolesaOrderCarrierChoices(@Ctx() ctx: RequestContext, @Args() args: { orderId: ID }) {
        const order = await this.orderService.findOne(ctx, args.orderId, ['lines', 'lines.productVariant']);
        if (!order) {
            throw new UserInputError('Order not found');
        }
        return this.rateService.carrierChoicesForOrder(ctx, order);
    }

    @Query()
    @Allow(bolesaShipmentPermission.Read)
    async bolesaShipments(
        @Ctx() ctx: RequestContext,
        @Args() args: { syncStatus?: string; take?: number; skip?: number },
    ) {
        return this.shipmentService.listForChannel(ctx, args);
    }

    @Query()
    @Allow(bolesaShipmentPermission.Read)
    async bolesaShipment(@Ctx() ctx: RequestContext, @Args() args: { fulfillmentId: string }) {
        return this.shipmentService.findByFulfillmentId(ctx, args.fulfillmentId);
    }

    @Query()
    @Allow(bolesaShipmentPermission.Read)
    async bolesaOpsHealth(@Ctx() ctx: RequestContext) {
        return this.shipmentService.getOpsHealth(ctx);
    }

    @Transaction()
    @Mutation()
    @Allow(bolesaConnectionPermission.Write)
    async updateBolesaConnection(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: UpdateBolesaConnectionInput },
    ) {
        const conn = await this.connectionService.upsert(ctx, args.input);
        return this.connectionService.toPublicView(conn);
    }

    @Mutation()
    @Allow(bolesaConnectionPermission.Read)
    async testBolesaConnection(@Ctx() ctx: RequestContext) {
        return this.connectionService.testConnection(ctx);
    }

    @Mutation()
    @Allow(bolesaShipmentPermission.Write)
    async bolesaRetryShipment(@Ctx() ctx: RequestContext, @Args() args: { fulfillmentId: string }) {
        return this.shipmentService.retryShipment(ctx, args.fulfillmentId);
    }

    @Mutation()
    @Allow(bolesaShipmentPermission.Write)
    async bolesaRetryCancelShipment(@Ctx() ctx: RequestContext, @Args() args: { fulfillmentId: string }) {
        return this.shipmentService.retryCancelShipment(ctx, args.fulfillmentId);
    }

    @Mutation()
    @Allow(bolesaShipmentPermission.Write)
    async bolesaCancelShipment(@Ctx() ctx: RequestContext, @Args() args: { fulfillmentId: string }) {
        return this.shipmentService.requestCancel(ctx, args.fulfillmentId);
    }

    @Mutation()
    @Allow(bolesaShipmentPermission.Write)
    async bolesaAbandonShipment(@Ctx() ctx: RequestContext, @Args() args: { fulfillmentId: string }) {
        await this.shipmentService.abandonShipment(ctx, args.fulfillmentId);
        return true;
    }
}
