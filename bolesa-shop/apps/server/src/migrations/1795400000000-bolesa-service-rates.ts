import { MigrationInterface, QueryRunner } from 'typeorm';

/** Saved Partner service catalogue and the last prices returned by services/options. */
export class BolesaServiceRates1795400000000 implements MigrationInterface {
    name = 'BolesaServiceRates1795400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" ADD COLUMN IF NOT EXISTS "accountServices" text`,
        );
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" ADD COLUMN IF NOT EXISTS "serviceRates" text`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" DROP COLUMN IF EXISTS "serviceRates"`,
        );
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" DROP COLUMN IF EXISTS "accountServices"`,
        );
    }
}
