import { MigrationInterface, QueryRunner } from 'typeorm';

/** Channel settings for allow-open, automatic fulfillment, and offered services. */
export class BolesaMerchantSettings1795200000000 implements MigrationInterface {
    name = 'BolesaMerchantSettings1795200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" ADD COLUMN IF NOT EXISTS "allowOpen" boolean NOT NULL DEFAULT false`,
        );
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" ADD COLUMN IF NOT EXISTS "autoCreateAwb" boolean NOT NULL DEFAULT false`,
        );
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" ADD COLUMN IF NOT EXISTS "enabledServiceSlugs" text`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "bolesa_connection" DROP COLUMN IF EXISTS "enabledServiceSlugs"`,
        );
        await queryRunner.query(`ALTER TABLE "bolesa_connection" DROP COLUMN IF EXISTS "autoCreateAwb"`);
        await queryRunner.query(`ALTER TABLE "bolesa_connection" DROP COLUMN IF EXISTS "allowOpen"`);
    }
}
