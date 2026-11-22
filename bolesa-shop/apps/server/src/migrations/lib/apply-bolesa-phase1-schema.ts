import { QueryRunner } from 'typeorm';

/**
 * Idempotent Bolesa Phase 1 DDL (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 * Shared by the historical BolesaPhase1 migration (when core tables exist) and the
 * post-Init ensure migration used for fresh empty databases.
 */
export async function applyBolesaPhase1Schema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "bolesa_connection" (
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "bolesaAccountId" character varying(64),
                "apiBaseUrl" character varying(512) NOT NULL,
                "tokenEncrypted" text NOT NULL,
                "tokenLast4" character varying(8) NOT NULL DEFAULT '',
                "webhookSubscriptionUuid" character varying(64),
                "webhookSecretEncrypted" text,
                "webhookApproved" boolean NOT NULL DEFAULT false,
                "shipperAddress" text,
                "defaultServiceSlug" character varying(128),
                "shipmentCategory" character varying(16) NOT NULL DEFAULT 'dry',
                "creationMode" character varying(32) NOT NULL DEFAULT 'manual',
                "codEnabled" boolean NOT NULL DEFAULT true,
                "codFeeMode" character varying(32) NOT NULL DEFAULT 'absorb',
                "markupPercent" double precision NOT NULL DEFAULT 0,
                "isActive" boolean NOT NULL DEFAULT true,
                "lastVerifiedAt" TIMESTAMP,
                "id" SERIAL NOT NULL,
                CONSTRAINT "PK_bolesa_connection" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_bolesa_connection_isActive" ON "bolesa_connection" ("isActive")`,
    );

    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "bolesa_connection_channels_channel" (
                "bolesaConnectionId" integer NOT NULL,
                "channelId" integer NOT NULL,
                CONSTRAINT "PK_bolesa_connection_channels" PRIMARY KEY ("bolesaConnectionId", "channelId")
            )
        `);
    await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_bolesa_conn_ch_conn" ON "bolesa_connection_channels_channel" ("bolesaConnectionId")`,
    );
    await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_bolesa_conn_ch_channel" ON "bolesa_connection_channels_channel" ("channelId")`,
    );
    // DO/EXCEPTION keeps the migration transaction alive when the FK already exists.
    await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "bolesa_connection_channels_channel"
                ADD CONSTRAINT "FK_bolesa_conn_ch_conn"
                FOREIGN KEY ("bolesaConnectionId") REFERENCES "bolesa_connection"("id")
                ON DELETE CASCADE ON UPDATE NO ACTION;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);
    await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "bolesa_connection_channels_channel"
                ADD CONSTRAINT "FK_bolesa_conn_ch_channel"
                FOREIGN KEY ("channelId") REFERENCES "channel"("id")
                ON DELETE CASCADE ON UPDATE NO ACTION;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);

    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "bolesa_shipment" (
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "fulfillmentId" integer NOT NULL,
                "orderId" integer NOT NULL,
                "channelId" integer NOT NULL,
                "trackingNumber" character varying(64),
                "awbReference" character varying(64),
                "carrierServiceSlug" character varying(128),
                "statusCode" character varying(64),
                "labelUrl" text,
                "labelAvailability" character varying(32) NOT NULL DEFAULT 'unavailable',
                "codAmount" double precision,
                "issuingFees" text,
                "shipmentKey" character varying(160) NOT NULL,
                "idempotencyKey" character varying(180) NOT NULL,
                "attempt" integer NOT NULL DEFAULT 1,
                "syncStatus" character varying(32) NOT NULL DEFAULT 'requested',
                "codCollectionStatus" character varying(32) NOT NULL DEFAULT 'pending',
                "codRemittanceStatus" character varying(32) NOT NULL DEFAULT 'unknown',
                "lastStatusAt" TIMESTAMP,
                "lastErrorAt" TIMESTAMP,
                "lastError" text,
                "rawLastPayload" text,
                "id" SERIAL NOT NULL,
                CONSTRAINT "PK_bolesa_shipment" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_bolesa_shipment_fulfillmentId" UNIQUE ("fulfillmentId"),
                CONSTRAINT "UQ_bolesa_shipment_shipmentKey" UNIQUE ("shipmentKey"),
                CONSTRAINT "UQ_bolesa_shipment_idempotencyKey" UNIQUE ("idempotencyKey")
            )
        `);
    await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_bolesa_shipment_trackingNumber_notnull"
             ON "bolesa_shipment" ("trackingNumber") WHERE "trackingNumber" IS NOT NULL`,
    );

    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "bolesa_shipment_channels_channel" (
                "bolesaShipmentId" integer NOT NULL,
                "channelId" integer NOT NULL,
                CONSTRAINT "PK_bolesa_shipment_channels" PRIMARY KEY ("bolesaShipmentId", "channelId")
            )
        `);
    await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_bolesa_ship_ch_ship" ON "bolesa_shipment_channels_channel" ("bolesaShipmentId")`,
    );
    await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_bolesa_ship_ch_channel" ON "bolesa_shipment_channels_channel" ("channelId")`,
    );
    await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "bolesa_shipment_channels_channel"
                ADD CONSTRAINT "FK_bolesa_ship_ch_ship"
                FOREIGN KEY ("bolesaShipmentId") REFERENCES "bolesa_shipment"("id")
                ON DELETE CASCADE ON UPDATE NO ACTION;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);
    await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "bolesa_shipment_channels_channel"
                ADD CONSTRAINT "FK_bolesa_ship_ch_channel"
                FOREIGN KEY ("channelId") REFERENCES "channel"("id")
                ON DELETE CASCADE ON UPDATE NO ACTION;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);

    await queryRunner.query(
        `ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "customFieldsWeightkg" double precision`,
    );
    await queryRunner.query(
        `ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "customFieldsLengthcm" double precision`,
    );
    await queryRunner.query(
        `ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "customFieldsWidthcm" double precision`,
    );
    await queryRunner.query(
        `ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "customFieldsHeightcm" double precision`,
    );
    await queryRunner.query(
        `ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "customFieldsBolesacategory" character varying(255) DEFAULT 'dry'`,
    );

    await queryRunner.query(
        `ALTER TABLE "address" ADD COLUMN IF NOT EXISTS "customFieldsBolesacityhash" character varying(255)`,
    );
    await queryRunner.query(
        `ALTER TABLE "address" ADD COLUMN IF NOT EXISTS "customFieldsBolesacityname" character varying(255)`,
    );
    await queryRunner.query(
        `ALTER TABLE "address" ADD COLUMN IF NOT EXISTS "customFieldsDistrict" character varying(255)`,
    );

    await queryRunner.query(
        `ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "customFieldsPaymentpreference" character varying(255)`,
    );
    await queryRunner.query(
        `ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "customFieldsBolesaquote" text`,
    );

    await queryRunner.query(
        `ALTER TABLE "fulfillment" ADD COLUMN IF NOT EXISTS "customFieldsBolesatrackingnumber" character varying(255)`,
    );
    await queryRunner.query(
        `ALTER TABLE "fulfillment" ADD COLUMN IF NOT EXISTS "customFieldsBolesastatus" character varying(255)`,
    );
    await queryRunner.query(
        `ALTER TABLE "fulfillment" ADD COLUMN IF NOT EXISTS "customFieldsBolesasyncstatus" character varying(255)`,
    );
    await queryRunner.query(
        `ALTER TABLE "fulfillment" ADD COLUMN IF NOT EXISTS "customFieldsBolesalabelavailability" character varying(255)`,
    );
    await queryRunner.query(
        `ALTER TABLE "fulfillment" ADD COLUMN IF NOT EXISTS "customFieldsBolesashipmentkey" character varying(255)`,
    );
}

export async function dropBolesaPhase1Schema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "fulfillment" DROP COLUMN IF EXISTS "customFieldsBolesashipmentkey"`);
    await queryRunner.query(
        `ALTER TABLE "fulfillment" DROP COLUMN IF EXISTS "customFieldsBolesalabelavailability"`,
    );
    await queryRunner.query(`ALTER TABLE "fulfillment" DROP COLUMN IF EXISTS "customFieldsBolesasyncstatus"`);
    await queryRunner.query(`ALTER TABLE "fulfillment" DROP COLUMN IF EXISTS "customFieldsBolesastatus"`);
    await queryRunner.query(
        `ALTER TABLE "fulfillment" DROP COLUMN IF EXISTS "customFieldsBolesatrackingnumber"`,
    );
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN IF EXISTS "customFieldsBolesaquote"`);
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN IF EXISTS "customFieldsPaymentpreference"`);
    await queryRunner.query(`ALTER TABLE "address" DROP COLUMN IF EXISTS "customFieldsDistrict"`);
    await queryRunner.query(`ALTER TABLE "address" DROP COLUMN IF EXISTS "customFieldsBolesacityname"`);
    await queryRunner.query(`ALTER TABLE "address" DROP COLUMN IF EXISTS "customFieldsBolesacityhash"`);
    await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN IF EXISTS "customFieldsBolesacategory"`);
    await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN IF EXISTS "customFieldsHeightcm"`);
    await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN IF EXISTS "customFieldsWidthcm"`);
    await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN IF EXISTS "customFieldsLengthcm"`);
    await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN IF EXISTS "customFieldsWeightkg"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "bolesa_shipment_channels_channel"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bolesa_shipment"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bolesa_connection_channels_channel"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bolesa_connection"`);
}
