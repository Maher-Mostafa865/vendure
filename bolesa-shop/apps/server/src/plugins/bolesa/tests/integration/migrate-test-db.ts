/**
 * Apply project migrations ONLY to vendure-bolesa-test.
 *
 * On an empty database, TypeORM timestamp order would run BolesaPhase1 (1763…)
 * before Init (1794…), which fails because Bolesa alters core tables. This harness
 * runs Init first, then Bolesa — without modifying migration source files.
 *
 * Usage (from apps/server):
 *   npm run test:bolesa:migrate
 */
import 'reflect-metadata';

import path from 'node:path';

import { runMigrations, VendureConfig } from '@vendure/core';

import { assertTestDatabaseName, REQUIRED_TEST_DB } from './assert-test-db';
import { testConfig } from './test-vendure-config';

const migrationsDir = path.join(__dirname, '../../../../migrations');

function withMigrations(files: string[]): VendureConfig {
    const database = testConfig.dbConnectionOptions.database;
    assertTestDatabaseName(typeof database === 'string' ? database : undefined);
    return {
        ...testConfig,
        dbConnectionOptions: {
            ...testConfig.dbConnectionOptions,
            migrations: files,
        },
    };
}

async function main(): Promise<void> {
    const dbName = testConfig.dbConnectionOptions.database;
    assertTestDatabaseName(typeof dbName === 'string' ? dbName : undefined);
    if (dbName !== REQUIRED_TEST_DB) {
        throw new Error(`SAFETY ABORT before migrate: database=${String(dbName)}`);
    }

    const initMigration = path.join(migrationsDir, '1794915937588-init.ts');
    const bolesaMigration = path.join(migrationsDir, '1763590000000-bolesa-phase1.ts');

    // eslint-disable-next-line no-console
    console.log(`Migrating database: ${REQUIRED_TEST_DB} (Init then BolesaPhase1)`);

    const ranInit = await runMigrations(withMigrations([initMigration]));
    const ranBolesa = await runMigrations(withMigrations([bolesaMigration]));
    const ran = [...ranInit, ...ranBolesa];

    // eslint-disable-next-line no-console
    console.log(
        JSON.stringify(
            {
                database: REQUIRED_TEST_DB,
                order: ['Init1794915937588', 'BolesaPhase11763590000000'],
                migrationsRan: ran,
            },
            null,
            2,
        ),
    );

    if (ran.length === 0) {
        // eslint-disable-next-line no-console
        console.log('No pending migrations (schema already applied).');
    }
}

main().catch(err => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
});
