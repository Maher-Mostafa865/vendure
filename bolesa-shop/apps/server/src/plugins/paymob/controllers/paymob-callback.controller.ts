import { Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { Response } from 'express';

import { PAYMOB_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { PaymobSettlementService } from '../services/paymob-settlement.service';
import { PaymobPluginOptions } from '../types';

@Controller('payments/paymob')
export class PaymobCallbackController {
    constructor(
        private settlementService: PaymobSettlementService,
        @Inject(PAYMOB_PLUGIN_OPTIONS) private options: PaymobPluginOptions,
    ) {}

    @Post('notification')
    async notification(@Body() body: Record<string, unknown>, @Query() query: Record<string, unknown>) {
        const result = await this.settlementService.handleCallback({ body, query });
        Logger.verbose(
            `Paymob notification ok=${result.ok} settled=${result.settled} order=${result.orderCode} msg=${result.message}`,
            loggerCtx,
        );
        return { received: true, ...result };
    }

    @Get('return')
    async returnGet(
        @Query() query: Record<string, unknown>,
        @Res() res: Response,
    ) {
        return this.finishReturn(query, undefined, res);
    }

    @Post('return')
    async returnPost(
        @Body() body: Record<string, unknown>,
        @Query() query: Record<string, unknown>,
        @Res() res: Response,
    ) {
        return this.finishReturn(query, body, res);
    }

    private async finishReturn(
        query: Record<string, unknown>,
        body: Record<string, unknown> | undefined,
        res: Response,
    ) {
        const orderCodeHint =
            typeof query.orderCode === 'string'
                ? query.orderCode
                : typeof query.merchant_order_id === 'string'
                  ? query.merchant_order_id
                  : null;

        const result = await this.settlementService.handleCallback({
            body,
            query,
            orderCodeHint,
        });

        Logger.info(
            `Paymob return ok=${result.ok} settled=${result.settled} order=${result.orderCode} msg=${result.message}`,
            loggerCtx,
        );

        const storefront = this.options.storefrontBaseUrl.replace(/\/$/, '');
        if (result.orderCode) {
            const url = `${storefront}/order-confirmation/${encodeURIComponent(result.orderCode)}`;
            return res.redirect(302, url);
        }
        Logger.warn(`Paymob return without order code: ${result.message}`, loggerCtx);
        return res.redirect(302, `${storefront}/checkout`);
    }
}
