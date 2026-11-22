import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every variant needs a positive weight. Existing catalogs were created while
 * the column was nullable, so empty values are stored as 1 kg and the column
 * is required from here on.
 */
export class BolesaVariantWeight1795100000000 implements MigrationInterface {
    name = 'BolesaVariantWeight1795100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE "product_variant" SET "customFieldsWeightkg" = 1 WHERE "customFieldsWeightkg" IS NULL OR "customFieldsWeightkg" <= 0`,
        );
        await queryRunner.query(
            `ALTER TABLE "product_variant" ALTER COLUMN "customFieldsWeightkg" SET DEFAULT 1`,
        );
        await queryRunner.query(
            `ALTER TABLE "product_variant" ALTER COLUMN "customFieldsWeightkg" SET NOT NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "product_variant" ALTER COLUMN "customFieldsWeightkg" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "product_variant" ALTER COLUMN "customFieldsWeightkg" DROP DEFAULT`,
        );
    }
}
