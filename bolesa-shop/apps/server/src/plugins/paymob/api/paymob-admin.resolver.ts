import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, RequestContext, Transaction } from '@vendure/core';

import { paymobConnectionPermission } from '../permissions';
import {
    PaymobConnectionService,
    UpdatePaymobConnectionInput,
} from '../services/paymob-connection.service';
import { PaymobSettlementService } from '../services/paymob-settlement.service';

@Resolver()
export class PaymobAdminResolver {
    constructor(
        private connectionService: PaymobConnectionService,
        private settlementService: PaymobSettlementService,
    ) {}

    @Query()
    @Allow(paymobConnectionPermission.Read)
    async paymobConnection(@Ctx() ctx: RequestContext) {
        const conn = await this.connectionService.getForChannel(ctx);
        const marketCountry = String((ctx.channel as any).customFields?.marketCountry ?? 'EG');
        return this.connectionService.toPublicView(conn, marketCountry);
    }

    @Transaction()
    @Mutation()
    @Allow(paymobConnectionPermission.Write)
    async updatePaymobConnection(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: UpdatePaymobConnectionInput },
    ) {
        const conn = await this.connectionService.upsert(ctx, args.input);
        // Re-read channel custom fields after possible marketCountry update.
        const marketCountry = String(
            args.input.marketCountry ?? (ctx.channel as any).customFields?.marketCountry ?? 'EG',
        );
        return this.connectionService.toPublicView(conn, marketCountry);
    }

    @Transaction()
    @Mutation()
    @Allow(paymobConnectionPermission.Write)
    async settlePaymobPayment(@Args() args: { orderCode: string }) {
        return this.settlementService.settleByInquiry(args.orderCode);
    }
}
