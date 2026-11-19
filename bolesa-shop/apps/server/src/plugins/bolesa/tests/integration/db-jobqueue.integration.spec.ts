/**
 * Phase 1.5 — real PostgreSQL + Vendure JobQueue integration tests.
 * Targets ONLY vendure-bolesa-test. Never imports apps/server/.env.
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { JobState } from '@vendure/common/lib/generated-types';
import {
    bootstrapWorker,
    JobQueueService,
    RequestContextService,
    TransactionalConnection,
    VendureWorker,
} from '@vendure/core';
import pg, { Client as PgClient, ClientConfig as PgClientConfig } from 'pg';

import { CREATE_AWB_QUEUE } from '../../constants';
import { BolesaShipment } from '../../entities/bolesa-shipment.entity';
import { BolesaClient } from '../../services/bolesa-client.service';
import { BolesaShipmentService } from '../../services/bolesa-shipment.service';
import { assertTestDatabaseName, REQUIRED_TEST_DB } from './assert-test-db';
import { testConfig } from './test-vendure-config';

const HARMLESS_QUEUE = 'bolesa-integration-harmless';

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

describe('Phase 1.5 PostgreSQL + JobQueue integration (vendure-bolesa-test)', () => {
    let worker: VendureWorker;
    let shipmentService: BolesaShipmentService;
    let jobQueueService: JobQueueService;
    let connection: TransactionalConnection;
    let requestContextService: RequestContextService;
    let channelId: number;
    let channelIdB: number;
    let fetchCallCount = 0;
    let originalFetch: typeof globalThis.fetch;
    const evidence: Record<string, unknown> = {};

    before(async () => {
        assertTestDatabaseName(testConfig.dbConnectionOptions.database as string);
        assertTestDatabaseName(process.env.DB_NAME);

        await withPgClient(async client => {
            const tables = await client.query<{ tablename: string }>(
                `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('bolesa_shipment','job_record','channel')`,
            );
            assert.ok(
                tables.rows.some((r: { tablename: string }) => r.tablename === 'bolesa_shipment'),
                'bolesa_shipment missing — run migrate-test-db.ts first',
            );
            assert.ok(
                tables.rows.some((r: { tablename: string }) => r.tablename === 'job_record'),
                'job_record missing — run migrate-test-db.ts first',
            );
        });

        originalFetch = globalThis.fetch;
        globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
            fetchCallCount += 1;
            throw new Error('SAFETY: outbound fetch is forbidden in Bolesa integration tests');
        }) as typeof fetch;

        // Bootstrap Worker Nest context but do NOT start queue consumers yet.
        // Recovery/dedupe tests need jobs to remain PENDING in job_record.
        worker = await bootstrapWorker(testConfig);

        shipmentService = worker.app.get(BolesaShipmentService);
        jobQueueService = worker.app.get(JobQueueService);
        connection = worker.app.get(TransactionalConnection);
        requestContextService = worker.app.get(RequestContextService);

        // Stub Partner client — never hits network even if fetch ban is bypassed.
        const client = worker.app.get(BolesaClient);
        client.createAwb = (async () => {
            throw new Error('SAFETY: createAwb stub — Partner API blocked');
        }) as typeof client.createAwb;
        client.findAwbsByMeta = (async () => []) as typeof client.findAwbsByMeta;
        client.cancelAwb = (async () => {
            throw new Error('SAFETY: cancelAwb stub — Partner API blocked');
        }) as typeof client.cancelAwb;
        client.getAwb = (async () => null) as typeof client.getAwb;
        client.me = (async () => {
            throw new Error('SAFETY: me stub — Partner API blocked');
        }) as typeof client.me;
        client.searchCities = (async () => []) as typeof client.searchCities;
        client.serviceOptions = (async () => []) as typeof client.serviceOptions;

        channelId = await ensureChannel('bolesa-it-a', 'token-bolesa-it-a');
        channelIdB = await ensureChannel('bolesa-it-b', 'token-bolesa-it-b');

        await cleanupBolesaArtifacts();
    });

    after(async () => {
        try {
            await cleanupBolesaArtifacts();
        } catch {
            // ignore cleanup errors on shutdown
        }
        if (worker?.app) {
            await worker.app.close();
        }
        if (originalFetch) {
            globalThis.fetch = originalFetch;
        }
        // eslint-disable-next-line no-console
        console.log('INTEGRATION_EVIDENCE', JSON.stringify(evidence, null, 2));
    });

    async function ensureChannel(code: string, token: string): Promise<number> {
        return withPgClient(async client => {
            const existing = await client.query<{ id: number }>(
                `SELECT id FROM channel WHERE code = $1`,
                [code],
            );
            if (existing.rows[0]) {
                return existing.rows[0].id;
            }
            const inserted = await client.query<{ id: number }>(
                `INSERT INTO channel
                  (code, token, "defaultLanguageCode", "defaultCurrencyCode", "pricesIncludeTax",
                   "availableLanguageCodes", "availableCurrencyCodes", "trackInventory", "outOfStockThreshold", description)
                 VALUES ($1,$2,'en','EGP',false,'en','EGP',true,0,'bolesa integration')
                 RETURNING id`,
                [code, token],
            );
            return inserted.rows[0].id;
        });
    }

    async function cleanupBolesaArtifacts(): Promise<void> {
        await withPgClient(async client => {
            await client.query(`DELETE FROM bolesa_shipment_channels_channel`);
            await client.query(`DELETE FROM bolesa_shipment`);
            await client.query(
                `DELETE FROM job_record WHERE "queueName" LIKE 'bolesa%' OR "queueName" = $1`,
                [HARMLESS_QUEUE],
            );
        });
    }

    async function insertRequestedShipment(opts: {
        fulfillmentId: number;
        channelId: number;
        attempt?: number;
        ageMs?: number;
        keyPrefix?: string;
    }): Promise<{ id: number; shipmentKey: string; attempt: number }> {
        const attempt = opts.attempt ?? 1;
        const prefix = opts.keyPrefix ?? 'it';
        const shipmentKey = `${prefix}-f${opts.fulfillmentId}-c${opts.channelId}`;
        const idempotencyKey = `${shipmentKey}-a${attempt}`;
        const ageMs = opts.ageMs ?? 120_000;
        return withPgClient(async client => {
            const res = await client.query<{ id: number }>(
                `INSERT INTO bolesa_shipment
                  ("fulfillmentId","orderId","channelId","shipmentKey","idempotencyKey",attempt,"syncStatus",
                   "labelAvailability","codCollectionStatus","codRemittanceStatus","createdAt","updatedAt")
                 VALUES ($1,0,$2,$3,$4,$5,'requested','unavailable','pending','unknown',
                         NOW() - ($6 || ' milliseconds')::interval,
                         NOW() - ($6 || ' milliseconds')::interval)
                 RETURNING id`,
                [opts.fulfillmentId, opts.channelId, shipmentKey, idempotencyKey, attempt, String(ageMs)],
            );
            return { id: res.rows[0].id, shipmentKey, attempt };
        });
    }

    async function countActiveCreateJobs(fulfillmentId: number, channelId: number, attempt: number): Promise<number> {
        return withPgClient(async client => {
            const res = await client.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM job_record
                 WHERE "queueName" = $1
                   AND state IN ('PENDING','RUNNING','RETRYING')
                   AND data::jsonb->>'fulfillmentId' = $2
                   AND data::jsonb->>'channelId' = $3
                   AND data::jsonb->>'attempt' = $4`,
                [CREATE_AWB_QUEUE, String(fulfillmentId), String(channelId), String(attempt)],
            );
            return Number(res.rows[0].count);
        });
    }

    async function insertRawJob(opts: {
        state: JobState;
        fulfillmentId: number;
        channelId: number;
        attempt: number;
    }): Promise<number> {
        return withPgClient(async client => {
            const data = JSON.stringify({
                fulfillmentId: opts.fulfillmentId,
                channelId: opts.channelId,
                attempt: opts.attempt,
            });
            const res = await client.query<{ id: number }>(
                `INSERT INTO job_record
                  ("queueName", data, state, progress, "isSettled", retries, attempts, "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, 0, false, 5, 0, NOW(), NOW())
                 RETURNING id`,
                [CREATE_AWB_QUEUE, data, opts.state],
            );
            return res.rows[0].id;
        });
    }

    it('1) persists a requested BolesaShipment in PostgreSQL', async () => {
        const row = await insertRequestedShipment({ fulfillmentId: 9001, channelId });
        const found = await withPgClient(async client => {
            const res = await client.query(
                `SELECT id, "syncStatus", "channelId", "fulfillmentId" FROM bolesa_shipment WHERE id = $1`,
                [row.id],
            );
            return res.rows[0];
        });
        assert.equal(found.syncStatus, 'requested');
        assert.equal(Number(found.channelId), channelId);
        evidence.test1 = { shipmentId: row.id, syncStatus: found.syncStatus, database: REQUIRED_TEST_DB };
    });

    it('2) recovery enqueues a missing create-AWB job', async () => {
        const fulfillmentId = 9002;
        await insertRequestedShipment({ fulfillmentId, channelId, ageMs: 120_000 });
        const before = await countActiveCreateJobs(fulfillmentId, channelId, 1);
        assert.equal(before, 0);

        const result = await shipmentService.recoverOrphanedRequestedShipments();
        const after = await countActiveCreateJobs(fulfillmentId, channelId, 1);

        assert.ok(result.enqueued >= 1, `expected enqueued>=1, got ${JSON.stringify(result)}`);
        assert.equal(after, 1);
        evidence.test2 = { recovery: result, activeJobs: after };
    });

    it('3) second recovery does not create a duplicate active job', async () => {
        const fulfillmentId = 9003;
        await insertRequestedShipment({ fulfillmentId, channelId, ageMs: 120_000 });
        await shipmentService.recoverOrphanedRequestedShipments();
        const mid = await countActiveCreateJobs(fulfillmentId, channelId, 1);
        assert.equal(mid, 1);

        const second = await shipmentService.recoverOrphanedRequestedShipments();
        const after = await countActiveCreateJobs(fulfillmentId, channelId, 1);
        assert.equal(after, 1);
        assert.equal(second.enqueued, 0);
        evidence.test3 = { second, activeJobs: after };
    });

    it('4) detects existing PENDING, RUNNING, and RETRYING jobs', async () => {
        const cases: JobState[] = [JobState.PENDING, JobState.RUNNING, JobState.RETRYING];
        const results: Record<string, boolean> = {};
        for (const [i, state] of cases.entries()) {
            const fulfillmentId = 9100 + i;
            await insertRequestedShipment({ fulfillmentId, channelId, ageMs: 120_000 });
            await insertRawJob({ state, fulfillmentId, channelId, attempt: 1 });
            const detected = await shipmentService.hasActiveCreateAwbJob({
                fulfillmentId,
                channelId,
                attempt: 1,
            });
            assert.equal(detected, true, `expected detect ${state}`);
            results[state] = detected;

            const decision = await shipmentService.ensureCreateAwbJobEnqueued(
                {
                    fulfillmentId,
                    channelId,
                    attempt: 1,
                    syncStatus: 'requested',
                    updatedAt: new Date(Date.now() - 120_000),
                } as BolesaShipment,
                { ignoreGracePeriod: true },
            );
            assert.equal(decision, 'skip_active_job', state);
            assert.equal(await countActiveCreateJobs(fulfillmentId, channelId, 1), 1);
        }
        evidence.test4 = results;
    });

    it('5) enforces channel isolation for active-job matching', async () => {
        const fulfillmentId = 9200;
        await insertRequestedShipment({ fulfillmentId, channelId, ageMs: 120_000 });
        await insertRequestedShipment({
            fulfillmentId: 9201,
            channelId: channelIdB,
            ageMs: 120_000,
            keyPrefix: 'itb',
        });
        await insertRawJob({
            state: JobState.PENDING,
            fulfillmentId,
            channelId,
            attempt: 1,
        });

        assert.equal(
            await shipmentService.hasActiveCreateAwbJob({
                fulfillmentId,
                channelId,
                attempt: 1,
            }),
            true,
        );
        assert.equal(
            await shipmentService.hasActiveCreateAwbJob({
                fulfillmentId: 9201,
                channelId: channelIdB,
                attempt: 1,
            }),
            false,
        );
        evidence.test5 = { channelA: channelId, channelB: channelIdB };
    });

    it('6) transaction rollback leaves no unintended shipment state', async () => {
        const fulfillmentId = 9300;
        const shipmentKey = `rollback-f${fulfillmentId}`;
        const ctx = await requestContextService.create({ apiType: 'admin' });

        await assert.rejects(async () => {
            await connection.withTransaction(ctx, async txCtx => {
                const repo = connection.getRepository(txCtx, BolesaShipment);
                await repo.save(
                    new BolesaShipment({
                        fulfillmentId,
                        orderId: 0,
                        channelId,
                        shipmentKey,
                        idempotencyKey: `${shipmentKey}-a1`,
                        attempt: 1,
                        syncStatus: 'requested',
                        labelAvailability: 'unavailable',
                        codCollectionStatus: 'pending',
                        codRemittanceStatus: 'unknown',
                    }),
                );
                throw new Error('intentional rollback');
            });
        });

        const count = await withPgClient(async client => {
            const res = await client.query(
                `SELECT count(*)::int AS c FROM bolesa_shipment WHERE "shipmentKey" = $1`,
                [shipmentKey],
            );
            return res.rows[0].c as number;
        });
        assert.equal(count, 0);
        evidence.test6 = { rolledBackKey: shipmentKey, remainingRows: count };
    });

    it('7) concurrent recovery does not produce duplicate active jobs', async () => {
        const fulfillmentId = 9400;
        await insertRequestedShipment({ fulfillmentId, channelId, ageMs: 120_000 });

        const [a, b] = await Promise.all([
            shipmentService.recoverOrphanedRequestedShipments(),
            shipmentService.recoverOrphanedRequestedShipments(),
        ]);
        const active = await countActiveCreateJobs(fulfillmentId, channelId, 1);
        assert.equal(active, 1, `expected exactly 1 active job, got ${active}; a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
        evidence.test7 = { a, b, active };
    });

    it('8) pessimistic locking blocks a second PostgreSQL session (FOR UPDATE)', async () => {
        const row = await insertRequestedShipment({ fulfillmentId: 9500, channelId, ageMs: 120_000 });
        const c1 = new pg.Client(pgConfig());
        const c2 = new pg.Client(pgConfig());
        await c1.connect();
        await c2.connect();
        try {
            const db1 = String((await c1.query('SELECT current_database() AS d')).rows[0].d);
            const db2 = String((await c2.query('SELECT current_database() AS d')).rows[0].d);
            assertTestDatabaseName(db1);
            assertTestDatabaseName(db2);

            await c1.query('BEGIN');
            await c1.query(`SELECT id FROM bolesa_shipment WHERE id = $1 FOR UPDATE`, [row.id]);

            await c2.query(`SET lock_timeout = '400ms'`);
            await c2.query('BEGIN');
            let blocked = false;
            try {
                await c2.query(`SELECT id FROM bolesa_shipment WHERE id = $1 FOR UPDATE`, [row.id]);
            } catch (e: any) {
                blocked = /lock timeout|canceling statement|could not obtain lock/i.test(String(e.message));
                assert.ok(blocked, `unexpected lock error: ${e.message}`);
            }
            assert.equal(blocked, true, 'second session should have been blocked by FOR UPDATE');
            await c2.query('ROLLBACK');
            await c1.query('ROLLBACK');
            evidence.test8 = { shipmentId: row.id, secondSessionBlocked: blocked, database: REQUIRED_TEST_DB };
        } finally {
            await c1.end();
            await c2.end();
        }
    });

    it('9) Worker consumes a harmless JobQueue job (mocked Partner path)', async () => {
        // Remove any create/cancel jobs left by recovery tests so startJobQueue cannot
        // hit the AWB processor (Partner path is stubbed/banned anyway).
        await withPgClient(async client => {
            await client.query(
                `DELETE FROM job_record WHERE "queueName" IN ($1, $2)`,
                [CREATE_AWB_QUEUE, 'bolesa-cancel-awb'],
            );
        });

        const queue = await jobQueueService.createQueue<{ ping: boolean; nonce: string }>({
            name: HARMLESS_QUEUE,
            process: async job => {
                assert.equal(job.data.ping, true);
                return { ok: true, echo: job.data.nonce };
            },
        });

        await worker.startJobQueue();
        // Queue registered after start — start it explicitly.
        await queue.start();

        const nonce = `n-${Date.now()}`;
        const job = await queue.add({ ping: true, nonce }, { retries: 1 });
        const jobId = job.id;

        const completed = await withPgClient(async client => {
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline) {
                const res = await client.query(
                    `SELECT id, state, result FROM job_record WHERE id = $1`,
                    [jobId],
                );
                const row = res.rows[0];
                if (row && row.state === JobState.COMPLETED) {
                    return row;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            return null;
        });

        assert.ok(completed, `job ${jobId} did not complete`);
        assert.equal(completed.state, JobState.COMPLETED);
        evidence.test9 = { jobId, state: completed.state, result: completed.result };
    });

    it('10) no outbound Partner API fetch occurred during the suite', async () => {
        assert.equal(fetchCallCount, 0, `fetch was called ${fetchCallCount} time(s)`);
        evidence.test10 = { fetchCallCount, partnerBaseUrl: process.env.BOLESA_API_BASE_URL };
    });
});
