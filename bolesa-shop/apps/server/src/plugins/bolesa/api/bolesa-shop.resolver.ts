import { Args, Query, Resolver } from '@nestjs/graphql';
import { Ctx, RequestContext } from '@vendure/core';

import { BolesaConnectionService } from '../services/bolesa-connection.service';
import { BolesaClient } from '../services/bolesa-client.service';

@Resolver()
export class BolesaShopResolver {
    constructor(
        private connectionService: BolesaConnectionService,
        private client: BolesaClient,
    ) {}

    @Query()
    async bolesaSearchCities(@Ctx() ctx: RequestContext, @Args() args: { query: string }) {
        if (!args.query || args.query.trim().length < 2) {
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
