import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Shopper-selected Partner service slug. Existing databases already applied
 * Bolesa Phase 1, so this column is added on its own.
 */
export class BolesaServiceSlug1795000000000 implements MigrationInterface {
    name = 'BolesaServiceSlug1795000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "customFieldsBolesaserviceslug" character varying(255)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order" DROP COLUMN IF EXISTS "customFieldsBolesaserviceslug"`);
    }
}
