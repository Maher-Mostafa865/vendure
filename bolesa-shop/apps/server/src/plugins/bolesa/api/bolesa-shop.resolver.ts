import { Inject } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { Ctx, Logger, PaymentMethod, RequestContext, TransactionalConnection } from '@vendure/core';

import { BOLESA_COD_HANDLER_CODE, BOLESA_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { BolesaClient } from '../services/bolesa-client.service';
import { BolesaConnectionService } from '../services/bolesa-connection.service';
import { BolesaPluginOptions } from '../types';
import {
    DEFAULT_CITY_SEARCH_RATE_LIMIT,
    FixedWindowRateLimiter,
} from '../util/rate-limit';
import { orderMinimumMinor } from '../config/bolesa-cod-eligibility-checker';

@Resolver()
export class BolesaShopResolver {
    private readonly citySearchLimiter: FixedWindowRateLimiter;

    constructor(
        private connectionService: BolesaConnectionService,
        private client: BolesaClient,
        private db: TransactionalConnection,
        @Inject(BOLESA_PLUGIN_OPTIONS) options: BolesaPluginOptions,
    ) {
        this.citySearchLimiter = new FixedWindowRateLimiter(
            options.citySearchRateLimit ?? DEFAULT_CITY_SEARCH_RATE_LIMIT,
        );
    }

    @Query()
    async bolesaCheckoutPolicy(@Ctx() ctx: RequestContext) {
        const methods = await this.db
            .getRepository(ctx, PaymentMethod)
            .createQueryBuilder('pm')
            .innerJoin('pm.channels', 'ch', 'ch.id = :channelId', { channelId: ctx.channelId })
            .andWhere('pm.enabled = :enabled', { enabled: true })
            .getMany();
        const codMethods = methods.filter(method => method.handler?.code === BOLESA_COD_HANDLER_CODE);
        const minimums = codMethods.map(method => orderMinimumMinor(method.checker));
        return {
            codEnabled: codMethods.length > 0,
            codMinimumMinor: minimums.length ? Math.min(...minimums) : 0,
            codPaymentMethodCodes: codMethods.map(method => method.code),
        };
    }

    @Query()
    async bolesaSearchCities(@Ctx() ctx: RequestContext, @Args() args: { query: string }) {
        if (!args.query || args.query.trim().length < 2) {
            return [];
        }
        const limitKey = `city:${String(ctx.channelId)}:${ctx.session?.id ?? ctx.req?.ip ?? 'anon'}`;
        const limit = this.citySearchLimiter.attempt(limitKey);
        if (!limit.allowed) {
            Logger.warn(
                `bolesaSearchCities rate-limited channel=${String(ctx.channelId)} retryAfterMs=${limit.retryAfterMs}`,
                loggerCtx,
            );
            return [];
        }
        try {
            const conn = await this.connectionService.requireActive(ctx);
            return this.client.searchCities(this.connectionService.authFor(conn), args.query.trim());
        } catch {
            return [];
        }
    }
}
