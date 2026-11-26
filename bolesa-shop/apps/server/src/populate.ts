/**
 * Seed catalog into the current DB (does not wipe tables).
 *
 *   PORT=3999 node -r reflect-metadata -r ts-node/register src/populate.ts
 *
 * After populate, run the Worker (`npm run dev:worker`) so `update-search-index`
 * and `apply-collection-filters` jobs finish — the storefront `search` query
 * stays empty until the search index is built.
 */
import 'dotenv/config';
import path from 'path';

import { bootstrap, JobQueueService, Logger, mergeConfig } from '@vendure/core';
import { populate } from '@vendure/core/cli';

import { initialData } from './initial-data';
import { seedMarkets } from './seed/seed-markets';
import { config } from './vendure-config';

const mockDataRoot = path.resolve(__dirname, '../../../../packages/core/mock-data');
const productsCsv = path.join(mockDataRoot, 'data-sources/products.csv');
const assetsDir = path.join(mockDataRoot, 'assets');

const populateConfig = mergeConfig(config, {
    apiOptions: {
        ...config.apiOptions,
        port: +(process.env.PORT || 3999),
    },
    importExportOptions: {
        importAssetsDir: assetsDir,
    },
});

populate(
    () =>
        bootstrap(populateConfig).then(async app => {
            await app.get(JobQueueService).start();
            return app;
        }),
    initialData,
    productsCsv,
)
    .then(async app => {
        Logger.info('Catalog populated — seeding EG/SA markets (Bolesa + Paymob)');
        await seedMarkets(app);
        Logger.info('Populate finished — closing app');
        await app.close();
        process.exit(0);
    })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
