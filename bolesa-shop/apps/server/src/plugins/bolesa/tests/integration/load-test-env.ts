import { config as loadDotenv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

import { assertTestDatabaseName, REQUIRED_TEST_DB } from './assert-test-db';

/**
 * Load ONLY apps/server/.env.test with override:true.
 * Does not fall back to .env / vendure-dev.
 */
export function loadTestEnv(): void {
    const envPath = path.resolve(__dirname, '../../../../../.env.test');
    if (!fs.existsSync(envPath)) {
        throw new Error(`SAFETY ABORT: missing test env file at ${envPath}`);
    }

    // Prevent silent inheritance of a parent shell DB_NAME=vendure-dev before override.
    delete process.env.DB_NAME;

    const result = loadDotenv({ path: envPath, override: true });
    if (result.error) {
        throw result.error;
    }

    assertTestDatabaseName(process.env.DB_NAME);

    if (process.env.DB_NAME !== REQUIRED_TEST_DB) {
        throw new Error('SAFETY ABORT: post-load DB_NAME mismatch');
    }
}
