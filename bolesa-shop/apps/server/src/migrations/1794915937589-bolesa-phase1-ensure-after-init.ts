import { MigrationInterface, QueryRunner } from 'typeorm';

import { applyBolesaPhase1Schema, dropBolesaPhase1Schema } from './lib/apply-bolesa-phase1-schema';

/**
 * Ensures Bolesa Phase 1 schema after Init on fresh databases.
 *
 * Timestamp is after Init1794915937588 so default `runMigrations` order is:
 *   1) BolesaPhase11763590000000 — no-op if Init not present
 *   2) Init1794915937588 — core schema
 *   3) BolesaPhase1EnsureAfterInit — apply Bolesa DDL (IF NOT EXISTS)
 *
 * Upgrade path: if historical BolesaPhase1 already created tables, this is a no-op.
 */
export class BolesaPhase1EnsureAfterInit1794915937589 implements MigrationInterface {
    name = 'BolesaPhase1EnsureAfterInit1794915937589';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const channelExists = await queryRunner.hasTable('channel');
        if (!channelExists) {
            throw new Error(
                'BolesaPhase1EnsureAfterInit requires Init (channel table). Run core Init migration first.',
            );
        }
        await applyBolesaPhase1Schema(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Only drop if the historical migration is also reverted; prefer explicit ops.
        // Leaving schema in place on down avoids accidental data loss when only Ensure is reverted.
        const historicalApplied = await queryRunner.query(
            `SELECT 1 FROM migrations WHERE name = $1 LIMIT 1`,
            ['BolesaPhase11763590000000'],
        );
        if (Array.isArray(historicalApplied) && historicalApplied.length > 0) {
            return;
        }
        await dropBolesaPhase1Schema(queryRunner);
    }
}
