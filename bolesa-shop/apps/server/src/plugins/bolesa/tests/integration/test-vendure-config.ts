import 'reflect-metadata';

import path from 'node:path';

import {
    DefaultEncryptionStrategy,
    DefaultJobQueuePlugin,
    dummyPaymentHandler,
    VendureConfig,
} from '@vendure/core';

import { BolesaPlugin } from '../../bolesa.plugin';
import { assertTestDatabaseName, REQUIRED_TEST_DB } from './assert-test-db';
import { loadTestEnv } from './load-test-env';

// Eager load + assert before any config object is constructed.
loadTestEnv();
assertTestDatabaseName(process.env.DB_NAME);

const migrationsGlob = path.join(__dirname, '../../../../migrations/*.{js,ts}');

/**
 * Minimal Vendure config for Phase 1.5 DB/JobQueue integration tests.
 * Targets ONLY vendure-bolesa-test. No scheduler (avoids reconcile Partner polls).
 * Partner base URL is intentionally unroutable; tests also stub BolesaClient + ban fetch.
 */
export const testConfig: VendureConfig = {
    apiOptions: {
        port: 0,
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
    },
    authOptions: {
        tokenMethod: ['bearer', 'cookie'],
        superadminCredentials: {
            identifier: process.env.SUPERADMIN_USERNAME || 'superadmin',
            password: process.env.SUPERADMIN_PASSWORD || 'superadmin',
        },
        cookieOptions: {
            secret: process.env.COOKIE_SECRET || 'bolesa-test-cookie-secret',
        },
    },
    dbConnectionOptions: {
        type: 'postgres',
        synchronize: false,
        migrations: [migrationsGlob],
        logging: false,
        database: (() => {
            assertTestDatabaseName(process.env.DB_NAME);
            return process.env.DB_NAME;
        })(),
        schema: process.env.DB_SCHEMA || 'public',
        host: process.env.DB_HOST || '127.0.0.1',
        port: +(process.env.DB_PORT || 6543),
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    systemOptions: {
        encryptionStrategy: new DefaultEncryptionStrategy({
            secret: process.env.VENDURE_ENCRYPTION_KEY || 'bolesa-test-encryption-key',
        }),
    },
    plugins: [
        BolesaPlugin.init({
            apiBaseUrl: process.env.BOLESA_API_BASE_URL || 'http://127.0.0.1:9/forbidden-partner-api',
            encryptionSecret: process.env.VENDURE_ENCRYPTION_KEY || 'bolesa-test-encryption-key',
            rateCacheTtlMs: 60_000,
            defaultCountryCode: 'EG',
        }),
        DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
    ],
};

if (testConfig.dbConnectionOptions.database !== REQUIRED_TEST_DB) {
    throw new Error(
        `SAFETY ABORT: testConfig.database=${String(testConfig.dbConnectionOptions.database)}`,
    );
}
