/**
 * Idempotent EG + SA market bootstrap (channels, Bolesa, Paymob).
 *
 *   PORT=3999 node -r reflect-metadata -r ts-node/register src/seed-markets.ts
 *
 * Secrets come from apps/server/.env (never commit real keys).
 */
import 'dotenv/config';

import { bootstrap, JobQueueService, Logger, mergeConfig } from '@vendure/core';

import { seedMarkets } from './seed/seed-markets';
import { config } from './vendure-config';

const seedConfig = mergeConfig(config, {
    apiOptions: {
        ...config.apiOptions,
        port: +(process.env.PORT || 3999),
    },
});

bootstrap(seedConfig)
    .then(async app => {
        await app.get(JobQueueService).start();
        const result = await seedMarkets(app);
        Logger.info(
            `Done. Use vendure-token ${result.egyptChannelToken} (EG) or ${result.saudiChannelToken} (SA)`,
        );
        await app.close();
        process.exit(0);
    })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
