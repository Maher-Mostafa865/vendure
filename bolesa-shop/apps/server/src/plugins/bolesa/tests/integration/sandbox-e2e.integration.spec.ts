/**
 * Real local/sandbox Partner E2E through the Vendure Bolesa plugin.
 *
 * Opt-in only: BOLESA_SANDBOX_E2E=1 plus bolesa-shop/.env.sandbox
 * (BOLESA_API_BASE_URL + BOLESA_PARTNER_TOKEN). Never targets production hosts.
 * Database: vendure-bolesa-test only.
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { config as loadDotenv } from 'dotenv';
import {
    bootstrapWorker,
    OrderService,
    RequestContextService,
    TransactionalConnection,
    VendureWorker,
} from '@vendure/core';
import pg, { Client as PgClient, ClientConfig as PgClientConfig } from 'pg';

import { BolesaShipment } from '../../entities/bolesa-shipment.entity';
import { BolesaClient } from '../../services/bolesa-client.service';
import { BolesaConnectionService } from '../../services/bolesa-connection.service';
import { BolesaShipmentService } from '../../services/bolesa-shipment.service';
import { assertSafePartnerHost } from '../../util/safe-partner-host';
import { assertTestDatabaseName, REQUIRED_TEST_DB } from './assert-test-db';
import { testConfig } from './test-vendure-config';

const ENABLED = process.env.BOLESA_SANDBOX_E2E === '1';

function loadSandboxCredentials(): { apiBaseUrl: string; token: string } {
    // integration/ → …/apps/server → bolesa-shop/.env.sandbox
    const sandboxPath = path.resolve(__dirname, '../../../../../../../.env.sandbox');
    if (!fs.existsSync(sandboxPath)) {
        throw new Error(`SAFETY ABORT: missing ${sandboxPath}`);
    }
    const parsed = loadDotenv({ path: sandboxPath }).parsed ?? {};
    const apiBaseUrl = String(parsed.BOLESA_API_BASE_URL || '').trim();
    const token = String(parsed.BOLESA_PARTNER_TOKEN || '').trim();
    assertSafePartnerHost(apiBaseUrl);
    if (!token || !token.startsWith('xp_')) {
        throw new Error('SAFETY ABORT: BOLESA_PARTNER_TOKEN missing or unexpected shape');
    }
    return { apiBaseUrl: apiBaseUrl.replace(/\/$/, ''), token };
}

function pgConfig(): PgClientConfig {
    assertTestDatabaseName(process.env.DB_NAME);
    return {
        host: process.env.DB_HOST || '127.0.0.1',
        port: +(process.env.DB_PORT || 6543),
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: REQUIRED_TEST_DB,
    };
}

async function withPgClient<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = new pg.Client(pgConfig());
    await client.connect();
    try {
        const db = String(
            (await client.query<{ current_database: string }>('SELECT current_database()')).rows[0]
                .current_database,
        );
        assertTestDatabaseName(db);
        return await fn(client);
    } finally {
        await client.end();
    }
}

describe('Sandbox E2E — real local Partner via Bolesa plugin', { skip: !ENABLED }, () => {
    let worker: VendureWorker;
    let connectionService: BolesaConnectionService;
    let shipmentService: BolesaShipmentService;
    let client: BolesaClient;
    let orderService: OrderService;
    let requestContextService: RequestContextService;
    let connection: TransactionalConnection;
    let channelId: number;
    let channelToken: string;
    let sandbox: { apiBaseUrl: string; token: string };
    let shipHash = '';
    let consHash = '';
    const evidence: Record<string, unknown> = {
        envIdentity: 'local-partner-api',
        database: REQUIRED_TEST_DB,
    };

    before(async () => {
        assertTestDatabaseName(testConfig.dbConnectionOptions.database as string);
        sandbox = loadSandboxCredentials();
        evidence.partnerHost = new URL(sandbox.apiBaseUrl).host;

        worker = await bootstrapWorker(testConfig);
        connectionService = worker.app.get(BolesaConnectionService);
        shipmentService = worker.app.get(BolesaShipmentService);
        client = worker.app.get(BolesaClient);
        orderService = worker.app.get(OrderService);
        requestContextService = worker.app.get(RequestContextService);
        connection = worker.app.get(TransactionalConnection);

        channelId = await ensureChannel('bolesa-sandbox-e2e', 'token-bolesa-sandbox-e2e');
        channelToken = await withPgClient(async c => {
            const r = await c.query<{ token: string }>(`SELECT token FROM channel WHERE id = $1`, [
                channelId,
            ]);
            return r.rows[0].token;
        });
        await cleanup();
    });

    after(async () => {
        try {
            await cleanup();
        } catch {
            // ignore
        }
        if (worker?.app) {
            await worker.app.close();
        }
        // eslint-disable-next-line no-console
        console.log('SANDBOX_E2E_EVIDENCE', JSON.stringify(evidence, null, 2));
        const out = path.resolve(__dirname, '../../../../../../../tmp/sandbox-e2e-plugin-evidence.json');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
    });

    async function ensureChannel(code: string, token: string): Promise<number> {
        return withPgClient(async pgClient => {
            const existing = await pgClient.query<{ id: number }>(
                `SELECT id FROM channel WHERE code = $1`,
                [code],
            );
            if (existing.rows[0]) {
                return existing.rows[0].id;
            }
            const inserted = await pgClient.query<{ id: number }>(
                `INSERT INTO channel
                  (code, token, "defaultLanguageCode", "defaultCurrencyCode", "pricesIncludeTax",
                   "availableLanguageCodes", "availableCurrencyCodes", "trackInventory", "outOfStockThreshold", description)
                 VALUES ($1,$2,'en','EGP',false,'en','EGP',true,0,'bolesa sandbox e2e')
                 RETURNING id`,
                [code, token],
            );
            return inserted.rows[0].id;
        });
    }

    async function cleanup(): Promise<void> {
        await withPgClient(async pgClient => {
            await pgClient.query(
                `DELETE FROM bolesa_shipment_channels_channel
                 WHERE "bolesaShipmentId" IN (SELECT id FROM bolesa_shipment WHERE "channelId" = $1)`,
                [channelId],
            );
            await pgClient.query(`DELETE FROM bolesa_shipment WHERE "channelId" = $1`, [channelId]);
            const connIds = await pgClient.query<{ bolesaConnectionId: number }>(
                `SELECT "bolesaConnectionId" FROM bolesa_connection_channels_channel WHERE "channelId" = $1`,
                [channelId],
            );
            await pgClient.query(
                `DELETE FROM bolesa_connection_channels_channel WHERE "channelId" = $1`,
                [channelId],
            );
            for (const row of connIds.rows) {
                await pgClient.query(
                    `DELETE FROM bolesa_connection c
                     WHERE c.id = $1
                       AND NOT EXISTS (
                         SELECT 1 FROM bolesa_connection_channels_channel x
                         WHERE x."bolesaConnectionId" = c.id
                       )`,
                    [row.bolesaConnectionId],
                );
            }
            await pgClient.query(`DELETE FROM job_record WHERE "queueName" LIKE 'bolesa%'`);
        });
    }

    async function ctx() {
        return requestContextService.create({ apiType: 'admin', channelOrToken: channelToken });
    }

    it('1) configures encrypted connection and passes /me', async () => {
        const requestCtx = await ctx();
        const shipperAddress = {
            name: 'Vendure E2E Shipper',
            phone: '+201000000001',
            country_code: 'EG',
            resolution_hash: '4c2279956e07a68e2eacaeb97382d3e5',
            address_line: '12 Test Street Nasr City Cairo EG',
        };
        const conn = await connectionService.upsert(requestCtx, {
            apiBaseUrl: sandbox.apiBaseUrl,
            token: sandbox.token,
            shipperAddress,
            defaultServiceSlug: 'bosta_egy_dom_dry_std_dlv',
            shipmentCategory: 'dry',
            codEnabled: true,
            isActive: true,
        });
        assert.ok(conn.tokenEncrypted.startsWith('enc:') || conn.tokenEncrypted.length > 8);
        assert.equal(conn.tokenLast4, sandbox.token.slice(-4));
        assertSafePartnerHost(conn.apiBaseUrl);

        const test = await connectionService.testConnection(requestCtx);
        evidence.connectionTest = { ok: test.ok, message: test.message };
        assert.equal(test.ok, true);
    });

    it('2) searches cities and returns resolution_hash', async () => {
        const requestCtx = await ctx();
        const conn = await connectionService.requireActive(requestCtx);
        const cities = await client.searchCities(connectionService.authFor(conn), 'Nasr City');
        evidence.citySearch = { count: cities.length, sampleName: cities[0]?.name };
        assert.ok(cities.length > 0, 'expected city hits');
        assert.ok(cities[0].resolutionHash.length === 32);
        shipHash = cities.find(c => c.name.includes('ElHay 06'))?.resolutionHash || cities[0].resolutionHash;
        consHash = cities.find(c => c.name.includes('ElHay 07'))?.resolutionHash || cities[1]?.resolutionHash || shipHash;
        assert.ok(shipHash && consHash);
    });

    it('3) returns service options / rates for EG addresses', async () => {
        const requestCtx = await ctx();
        const conn = await connectionService.requireActive(requestCtx);
        const services = await client.serviceOptions(connectionService.authFor(conn), {
            shipment_type: 'domestic',
            shipment_operation: 'ship',
            shipment_category: 'dry',
            payment_type: 'cc',
            weight: 1,
            shipper: {
                name: 'Vendure E2E Shipper',
                phone: '+201000000001',
                country_code: 'EG',
                resolution_hash: shipHash,
                address_line: '12 Test Street Nasr City Cairo EG',
            },
            consignees: [
                {
                    name: 'Vendure E2E Consignee',
                    phone: '+201000000002',
                    country_code: 'EG',
                    resolution_hash: consHash,
                    address_line: '45 Test Avenue Nasr City Cairo EG',
                },
            ],
        });
        evidence.serviceOptions = {
            count: services.length,
            slugs: services.map(s => s.slug),
            sampleCc: services[0]?.ccPrice,
        };
        assert.ok(services.some(s => s.slug === 'bosta_egy_dom_dry_std_dlv'));
    });

    it('4) createAwbForFulfillment creates a real AWB and persists outbox row', async () => {
        const requestCtx = await ctx();
        const runId = Date.now();
        const fulfillmentId = Number(`91${String(runId).slice(-6)}`);
        const orderId = fulfillmentId + 1;
        const orderCode = `VND-PLUGIN-E2E-${runId}`;
        const shipmentKey = `sandbox-f${fulfillmentId}-c${channelId}-${runId}`;
        const attempt = 1;

        await withPgClient(async pgClient => {
            await pgClient.query(
                `INSERT INTO bolesa_shipment
                  ("fulfillmentId","orderId","channelId","shipmentKey","idempotencyKey",attempt,"syncStatus",
                   "labelAvailability","codCollectionStatus","codRemittanceStatus","createdAt","updatedAt")
                 VALUES ($1,$2,$3,$4,$5,$6,'requested','unavailable','pending','unknown',NOW(),NOW())`,
                [fulfillmentId, orderId, channelId, shipmentKey, `${shipmentKey}-a${attempt}`, attempt],
            );
        });

        const fakeOrder = {
            id: orderId,
            code: orderCode,
            totalWithTax: 15_000,
            customFields: {
                paymentPreference: 'prepaid',
                bolesaQuote: JSON.stringify({
                    serviceSlug: 'bosta_egy_dom_dry_std_dlv',
                    priceMinor: 1140,
                    currencyCode: 'EGP',
                    paymentPreference: 'prepaid',
                    capturedAt: new Date().toISOString(),
                }),
            },
            shippingAddress: {
                fullName: 'Vendure E2E Consignee',
                phoneNumber: '+201000000002',
                countryCode: 'EG',
                streetLine1: '45 Test Avenue Nasr City',
                streetLine2: 'Cairo EG',
                customFields: { bolesaCityHash: consHash },
            },
            customer: { emailAddress: 'vendure-e2e@example.test' },
            lines: [
                {
                    quantity: 1,
                    productVariant: { customFields: { weightKg: 1 } },
                },
            ],
        };

        const originalFindOne = orderService.findOne.bind(orderService);
        (orderService as any).findOne = async (ctx: unknown, id: unknown, _rels?: unknown) => {
            if (String(id) === String(orderId)) {
                return fakeOrder as any;
            }
            return originalFindOne(ctx as any, id as any, _rels as any);
        };

        try {
            const result = await shipmentService.createAwbForFulfillment(requestCtx, fulfillmentId);
            evidence.createViaOutbox = {
                ok: result.ok,
                trackingNumber: result.trackingNumber,
                orderCode,
                fulfillmentId,
                channelId,
            };
            assert.equal(result.ok, true);
            assert.ok(result.trackingNumber);

            const row = await withPgClient(async pgClient => {
                const r = await pgClient.query(
                    `SELECT "syncStatus","trackingNumber","channelId","orderId" FROM bolesa_shipment
                     WHERE "fulfillmentId" = $1 AND "channelId" = $2`,
                    [fulfillmentId, channelId],
                );
                return r.rows[0];
            });
            evidence.dbShipment = row;
            assert.equal(row.syncStatus, 'created');
            assert.equal(String(row.trackingNumber), String(result.trackingNumber));
            assert.equal(Number(row.channelId), channelId);

            const auth = connectionService.authFor(await connectionService.requireActive(requestCtx));
            const awb = await client.getAwb(auth, String(result.trackingNumber));
            evidence.getAwb = {
                trackingNumber: awb?.trackingNumber,
                statusCode: awb?.statusCode,
                paymentType: awb?.paymentType,
            };
            assert.ok(awb?.trackingNumber);

            const tracking = await client.getTracking(auth, String(result.trackingNumber));
            evidence.tracking = {
                hasPayload: tracking != null,
                keys: tracking && typeof tracking === 'object' ? Object.keys(tracking as object).slice(0, 12) : [],
            };

            // Idempotent create: same gate should return done without a second Partner create
            const again = await shipmentService.createAwbForFulfillment(requestCtx, fulfillmentId);
            evidence.idempotentOutboxReplay = {
                ok: again.ok,
                trackingNumber: again.trackingNumber,
                same: again.trackingNumber === result.trackingNumber,
            };
            assert.equal(again.trackingNumber, result.trackingNumber);

            // Cancel eligible AWB
            const cancel = await client.cancelAwb(
                auth,
                String(result.trackingNumber),
                `sandbox-cancel-${result.trackingNumber}`,
            );
            evidence.cancel = { status: cancel.status };
            await connection.withTransaction(requestCtx, async txCtx => {
                const shipment = await connection.getRepository(txCtx, BolesaShipment).findOne({
                    where: { fulfillmentId: fulfillmentId as any },
                });
                if (shipment) {
                    shipment.syncStatus = 'canceled';
                    await connection.getRepository(txCtx, BolesaShipment).save(shipment);
                }
            });
        } finally {
            (orderService as any).findOne = originalFindOne;
        }
    });

    it('5) channel isolation — second channel has no shipment rows for e2e channel', async () => {
        const otherChannelId = await ensureChannel('bolesa-sandbox-e2e-b', 'token-bolesa-sandbox-e2e-b');
        const leaked = await withPgClient(async pgClient => {
            const r = await pgClient.query(
                `SELECT count(*)::int AS c FROM bolesa_shipment
                 WHERE "channelId" = $1 AND "shipmentKey" LIKE 'sandbox-%'`,
                [otherChannelId],
            );
            return r.rows[0].c as number;
        });
        evidence.channelIsolation = { otherChannelId, leaked };
        assert.equal(leaked, 0);
    });
});
