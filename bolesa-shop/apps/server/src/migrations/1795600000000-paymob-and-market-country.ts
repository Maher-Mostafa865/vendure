import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Channel marketCountry (EG|SA) for Paymob + Bolesa shipping,
 * and per-channel PaymobConnection with test/live credential sets.
 */
export class PaymobAndMarketCountry1795600000000 implements MigrationInterface {
    name = 'PaymobAndMarketCountry1795600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "channel"
            ADD COLUMN IF NOT EXISTS "customFieldsMarketcountry" character varying(8) DEFAULT 'EG'
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "paymob_connection" (
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "mode" character varying(8) NOT NULL DEFAULT 'test',
                "testCredentials" text,
                "liveCredentials" text,
                "isActive" boolean NOT NULL DEFAULT true,
                "id" SERIAL NOT NULL,
                CONSTRAINT "PK_paymob_connection" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_paymob_connection_isActive" ON "paymob_connection" ("isActive")`,
        );

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "paymob_connection_channels_channel" (
                "paymobConnectionId" integer NOT NULL,
                "channelId" integer NOT NULL,
                CONSTRAINT "PK_paymob_connection_channels" PRIMARY KEY ("paymobConnectionId", "channelId")
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_paymob_conn_ch_conn" ON "paymob_connection_channels_channel" ("paymobConnectionId")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_paymob_conn_ch_channel" ON "paymob_connection_channels_channel" ("channelId")`,
        );
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "paymob_connection_channels_channel"
                ADD CONSTRAINT "FK_paymob_conn_ch_conn"
                FOREIGN KEY ("paymobConnectionId") REFERENCES "paymob_connection"("id")
                ON DELETE CASCADE ON UPDATE NO ACTION;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "paymob_connection_channels_channel"
                ADD CONSTRAINT "FK_paymob_conn_ch_channel"
                FOREIGN KEY ("channelId") REFERENCES "channel"("id")
                ON DELETE CASCADE ON UPDATE NO ACTION;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "paymob_connection_channels_channel" DROP CONSTRAINT IF EXISTS "FK_paymob_conn_ch_channel"
        `);
        await queryRunner.query(`
            ALTER TABLE "paymob_connection_channels_channel" DROP CONSTRAINT IF EXISTS "FK_paymob_conn_ch_conn"
        `);
        await queryRunner.query(`DROP TABLE IF EXISTS "paymob_connection_channels_channel"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "paymob_connection"`);
        await queryRunner.query(`
            ALTER TABLE "channel" DROP COLUMN IF EXISTS "customFieldsMarketcountry"
        `);
    }
}
