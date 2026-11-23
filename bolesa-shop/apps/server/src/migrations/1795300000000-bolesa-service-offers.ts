import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-service priority, standard price, profit, and the COD goods minimum. */
export class BolesaServiceOffers1795300000000 implements MigrationInterface {
    name = 'BolesaServiceOffers1795300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" ADD COLUMN IF NOT EXISTS "serviceOffers" text`,
        );
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" ADD COLUMN IF NOT EXISTS "codMinimumMajor" double precision NOT NULL DEFAULT 1000`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" DROP COLUMN IF EXISTS "codMinimumMajor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" DROP COLUMN IF EXISTS "serviceOffers"`,
        );
    }
}
