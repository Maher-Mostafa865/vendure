import { Inject } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { Ctx, Logger, RequestContext } from '@vendure/core';

import { BOLESA_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { BolesaClient } from '../services/bolesa-client.service';
import { BolesaConnectionService } from '../services/bolesa-connection.service';
import { BolesaPluginOptions } from '../types';
import {
    DEFAULT_CITY_SEARCH_RATE_LIMIT,
    FixedWindowRateLimiter,
} from '../util/rate-limit';

@Resolver()
export class BolesaShopResolver {
    private readonly citySearchLimiter: FixedWindowRateLimiter;

    constructor(
        private connectionService: BolesaConnectionService,
        private client: BolesaClient,
        @Inject(BOLESA_PLUGIN_OPTIONS) options: BolesaPluginOptions,
    ) {
        this.citySearchLimiter = new FixedWindowRateLimiter(
            options.citySearchRateLimit ?? DEFAULT_CITY_SEARCH_RATE_LIMIT,
        );
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
