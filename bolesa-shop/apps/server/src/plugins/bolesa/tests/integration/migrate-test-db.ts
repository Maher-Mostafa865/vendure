/**
 * Apply project migrations ONLY to vendure-bolesa-test.
 *
 * Uses the same migration glob order as production (`runMigrations(testConfig)`):
 *   1) BolesaPhase1 (no-op if Init/channel missing)
 *   2) Init
 *   3) BolesaPhase1EnsureAfterInit
 *
 * Usage (from apps/server):
 *   npm run test:bolesa:migrate
 */
import 'reflect-metadata';

import { runMigrations } from '@vendure/core';

import { assertTestDatabaseName, REQUIRED_TEST_DB } from './assert-test-db';
import { testConfig } from './test-vendure-config';

async function main(): Promise<void> {
    const dbName = testConfig.dbConnectionOptions.database;
    assertTestDatabaseName(typeof dbName === 'string' ? dbName : undefined);
    if (dbName !== REQUIRED_TEST_DB) {
        throw new Error(`SAFETY ABORT before migrate: database=${String(dbName)}`);
    }

    // eslint-disable-next-line no-console
    console.log(`Migrating database: ${REQUIRED_TEST_DB} (production migration order)`);
    const ran = await runMigrations(testConfig);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ database: REQUIRED_TEST_DB, migrationsRan: ran }, null, 2));
}

main().catch(err => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
});
