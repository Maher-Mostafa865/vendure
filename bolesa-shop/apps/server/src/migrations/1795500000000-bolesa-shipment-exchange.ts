import { MigrationInterface, QueryRunner } from 'typeorm';

/** The Partner request and response for an AWB, so a refusal can be read later. */
export class BolesaShipmentExchange1795500000000 implements MigrationInterface {
    name = 'BolesaShipmentExchange1795500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "bolesa_shipment" ADD COLUMN IF NOT EXISTS "partnerRequest" text`,
        );
        await queryRunner.query(
            `ALTER TABLE "bolesa_shipment" ADD COLUMN IF NOT EXISTS "partnerResponse" text`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "bolesa_shipment" DROP COLUMN IF EXISTS "partnerResponse"`,
        );
        await queryRunner.query(
            `ALTER TABLE "bolesa_shipment" DROP COLUMN IF EXISTS "partnerRequest"`,
        );
    }
}
