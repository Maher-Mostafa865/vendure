import { MigrationInterface, QueryRunner } from 'typeorm';

import { applyBolesaPhase1Schema, dropBolesaPhase1Schema } from './lib/apply-bolesa-phase1-schema';

/**
 * Historical Bolesa Phase 1 migration (timestamp sorts BEFORE Init).
 *
 * Fresh empty DBs: TypeORM would run this before Init and fail on missing core tables.
 * When `channel` (Init) is absent we no-op; the post-Init ensure migration applies schema.
 *
 * Existing installs that already applied this migration are unchanged (not re-run).
 * Existing installs that applied it successfully already have Bolesa tables.
 */
export class BolesaPhase11763590000000 implements MigrationInterface {
    name = 'BolesaPhase11763590000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const channelExists = await queryRunner.hasTable('channel');
        if (!channelExists) {
            // Defer to BolesaPhase1EnsureAfterInit (timestamp after Init).
            return;
        }
        await applyBolesaPhase1Schema(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await dropBolesaPhase1Schema(queryRunner);
    }
}
