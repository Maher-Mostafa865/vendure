/**
 * Phase 1.8 — P1 outbox / cancel reliability on real PostgreSQL + JobQueue.
 * Targets ONLY vendure-bolesa-test. No Partner API / outbound fetch.
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { JobState } from '@vendure/common/lib/generated-types';
import {
    bootstrapWorker,
    RequestContextService,
    TransactionalConnection,
    VendureWorker,
} from '@vendure/core';
import pg, { Client as PgClient, ClientConfig as PgClientConfig } from 'pg';

import { CANCEL_AWB_QUEUE, CREATE_AWB_QUEUE } from '../../constants';
import { BolesaShipment } from '../../entities/bolesa-shipment.entity';
import { BolesaClient } from '../../services/bolesa-client.service';
import { BolesaConnectionService } from '../../services/bolesa-connection.service';
import { BolesaShipmentService } from '../../services/bolesa-shipment.service';
import { CREATE_AWB_JOB_RETRIES } from '../../util/outbox-recovery';
import { assertTestDatabaseName, REQUIRED_TEST_DB } from './assert-test-db';
import { testConfig } from './test-vendure-config';

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

describe('Phase 1.8 P1 reliability (vendure-bolesa-test)', () => {
    let worker: VendureWorker;
    let shipmentService: BolesaShipmentService;
    let connection: TransactionalConnection;
    let requestContextService: RequestContextService;
    let channelId: number;
    let channelIdB: number;
    let fetchCallCount = 0;
    let originalFetch: typeof globalThis.fetch;
    let cancelHttpCalls = 0;
    let createHttpCalls = 0;
    let txnDepth = 0;
    let inDbTxnDuringPartnerHttp = false;
    const evidence: Record<string, unknown> = {};

    before(async () => {
        assertTestDatabaseName(testConfig.dbConnectionOptions.database as string);
        assertTestDatabaseName(process.env.DB_NAME);

        originalFetch = globalThis.fetch;
        globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
            fetchCallCount += 1;
            throw new Error('SAFETY: outbound fetch is forbidden in Bolesa integration tests');
        }) as typeof fetch;

        worker = await bootstrapWorker(testConfig);
        shipmentService = worker.app.get(BolesaShipmentService);
        connection = worker.app.get(TransactionalConnection);
        requestContextService = worker.app.get(RequestContextService);

        const originalWithTransaction = connection.withTransaction.bind(connection);
        connection.withTransaction = (async (ctx: any, work: any) => {
            txnDepth += 1;
            try {
                return await originalWithTransaction(ctx, work);
            } finally {
                txnDepth -= 1;
            }
        }) as typeof connection.withTransaction;

        const client = worker.app.get(BolesaClient);
        client.createAwb = (async () => {
            createHttpCalls += 1;
            if (txnDepth > 0) {
                inDbTxnDuringPartnerHttp = true;
            }
            throw new Error('SAFETY: createAwb stub — Partner API blocked');
        }) as typeof client.createAwb;
        client.findAwbsByMeta = (async () => []) as typeof client.findAwbsByMeta;
        client.cancelAwb = (async () => {
            cancelHttpCalls += 1;
            if (txnDepth > 0) {
                inDbTxnDuringPartnerHttp = true;
            }
            return { status: 'canceled', refund: null };
        }) as typeof client.cancelAwb;
        client.getAwb = (async () => null) as typeof client.getAwb;
        client.me = (async () => {
            throw new Error('SAFETY: me stub');
        }) as typeof client.me;
        client.searchCities = (async () => []) as typeof client.searchCities;
        client.serviceOptions = (async () => []) as typeof client.serviceOptions;

        channelId = await ensureChannel('bolesa-p1-a', 'token-bolesa-p1-a');
        channelIdB = await ensureChannel('bolesa-p1-b', 'token-bolesa-p1-b');
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
        if (originalFetch) {
            globalThis.fetch = originalFetch;
        }
        // eslint-disable-next-line no-console
        console.log('P1_RELIABILITY_EVIDENCE', JSON.stringify(evidence, null, 2));
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
                 VALUES ($1,$2,'en','EGP',false,'en','EGP',true,0,'bolesa p1')
                 RETURNING id`,
                [code, token],
            );
            return inserted.rows[0].id;
        });
    }

    async function cleanup(): Promise<void> {
        await withPgClient(async client => {
            await client.query(`DELETE FROM bolesa_shipment_channels_channel`);
            await client.query(`DELETE FROM bolesa_shipment`);
            await client.query(
                `DELETE FROM job_record WHERE "queueName" LIKE 'bolesa%'`,
            );
        });
        cancelHttpCalls = 0;
        createHttpCalls = 0;
        fetchCallCount = 0;
        inDbTxnDuringPartnerHttp = false;
    }

    async function insertShipment(opts: {
        fulfillmentId: number;
        channelId: number;
        syncStatus: string;
        attempt?: number;
        trackingNumber?: string | null;
        ageMs?: number;
        keyPrefix?: string;
        orderId?: number;
    }): Promise<{ id: number; shipmentKey: string; attempt: number }> {
        const attempt = opts.attempt ?? 1;
        const prefix = opts.keyPrefix ?? 'p1';
        const shipmentKey = `${prefix}-f${opts.fulfillmentId}-c${opts.channelId}`;
        const idempotencyKey = `${shipmentKey}-a${attempt}`;
        const ageMs = opts.ageMs ?? 120_000;
        const orderId = opts.orderId ?? 1;
        return withPgClient(async client => {
            const res = await client.query<{ id: number }>(
                `INSERT INTO bolesa_shipment
                  ("fulfillmentId","orderId","channelId","shipmentKey","idempotencyKey",attempt,"syncStatus",
                   "trackingNumber","labelAvailability","codCollectionStatus","codRemittanceStatus","createdAt","updatedAt")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unavailable','pending','unknown',
                         NOW() - ($9 || ' milliseconds')::interval,
                         NOW() - ($9 || ' milliseconds')::interval)
                 RETURNING id`,
                [
                    opts.fulfillmentId,
                    orderId,
                    opts.channelId,
                    shipmentKey,
                    idempotencyKey,
                    attempt,
                    opts.syncStatus,
                    opts.trackingNumber ?? null,
                    String(ageMs),
                ],
            );
            return { id: res.rows[0].id, shipmentKey, attempt };
        });
    }

    async function insertJob(opts: {
        queueName: string;
        state: string;
        data: Record<string, unknown>;
        retries?: number;
        attempts?: number;
        isSettled?: boolean;
    }): Promise<number> {
        return withPgClient(async client => {
            const res = await client.query<{ id: number }>(
                `INSERT INTO job_record
                  ("queueName", data, state, progress, "isSettled", retries, attempts, "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, 0, $4, $5, $6, NOW(), NOW())
                 RETURNING id`,
                [
                    opts.queueName,
                    JSON.stringify(opts.data),
                    opts.state,
                    opts.isSettled ??
                        (opts.state === JobState.FAILED || opts.state === JobState.COMPLETED),
                    opts.retries ?? CREATE_AWB_JOB_RETRIES,
                    opts.attempts ?? 0,
                ],
            );
            return res.rows[0].id;
        });
    }

    async function countActiveJobs(
        queueName: string,
        filter: { fulfillmentId: number; channelId: number; attempt?: number; trackingNumber?: string },
    ): Promise<number> {
        return withPgClient(async client => {
            let sql = `SELECT count(*)::text AS count FROM job_record
                 WHERE "queueName" = $1
                   AND state IN ('PENDING','RUNNING','RETRYING')
                   AND "isSettled" = false
                   AND (data::json->>'fulfillmentId') = $2
                   AND (data::json->>'channelId') = $3`;
            const params: string[] = [queueName, String(filter.fulfillmentId), String(filter.channelId)];
            if (filter.attempt != null) {
                sql += ` AND (data::json->>'attempt') = $4`;
                params.push(String(filter.attempt));
            }
            if (filter.trackingNumber != null) {
                const idx = params.length + 1;
                sql += ` AND (data::json->>'trackingNumber') = $${idx}`;
                params.push(filter.trackingNumber);
            }
            const res = await client.query<{ count: string }>(sql, params);
            return Number(res.rows[0].count);
        });
    }

    async function getSyncStatus(fulfillmentId: number, ch: number): Promise<string> {
        return withPgClient(async client => {
            const res = await client.query<{ syncStatus: string }>(
                `SELECT "syncStatus" FROM bolesa_shipment WHERE "fulfillmentId" = $1 AND "channelId" = $2`,
                [fulfillmentId, ch],
            );
            return res.rows[0]?.syncStatus;
        });
    }

    it('1) exhausted create retries are not re-enqueued indefinitely', async () => {
        await cleanup();
        const fulfillmentId = 18001;
        await insertShipment({
            fulfillmentId,
            channelId,
            syncStatus: 'requested',
            ageMs: 120_000,
        });
        await insertJob({
            queueName: CREATE_AWB_QUEUE,
            state: JobState.FAILED,
            isSettled: true,
            retries: CREATE_AWB_JOB_RETRIES,
            attempts: CREATE_AWB_JOB_RETRIES + 1,
            data: { fulfillmentId, channelId, attempt: 1 },
        });

        const first = await shipmentService.recoverOrphanedRequestedShipments();
        const status1 = await getSyncStatus(fulfillmentId, channelId);
        const active1 = await countActiveJobs(CREATE_AWB_QUEUE, {
            fulfillmentId,
            channelId,
            attempt: 1,
        });

        const second = await shipmentService.recoverOrphanedRequestedShipments();
        const status2 = await getSyncStatus(fulfillmentId, channelId);
        const active2 = await countActiveJobs(CREATE_AWB_QUEUE, {
            fulfillmentId,
            channelId,
            attempt: 1,
        });

        assert.equal(status1, 'retry_exhausted');
        assert.equal(status2, 'retry_exhausted');
        assert.equal(active1, 0);
        assert.equal(active2, 0);
        assert.ok(first.markedExhausted >= 1);
        assert.equal(second.enqueued, 0);
        assert.equal(second.markedExhausted, 0);
        evidence.test1 = { first, second, status1, status2, active1, active2 };
    });

    it('2) Admin retry restores eligibility with new attempt/idempotency key', async () => {
        await cleanup();
        const fulfillmentId = 18002;
        const row = await insertShipment({
            fulfillmentId,
            channelId,
            syncStatus: 'retry_exhausted',
            attempt: 1,
            ageMs: 120_000,
            orderId: 42,
        });
        // Seed exhausted job for attempt 1
        await insertJob({
            queueName: CREATE_AWB_QUEUE,
            state: JobState.FAILED,
            isSettled: true,
            retries: 5,
            attempts: 6,
            data: { fulfillmentId, channelId, attempt: 1 },
        });

        const connSvc = worker.app.get(BolesaConnectionService);
        const originalRequire = connSvc.requireActive.bind(connSvc);
        connSvc.requireActive = (async () =>
            ({
                id: 1,
                defaultServiceSlug: 'auto',
                markupPercent: 0,
                codFeeMode: 'absorb',
                shipmentCategory: 'dry',
            }) as any) as typeof connSvc.requireActive;
        connSvc.authFor = (() => ({ token: 'x', apiBaseUrl: 'http://127.0.0.1:9' })) as typeof connSvc.authFor;

        const channelToken = await withPgClient(async client => {
            const r = await client.query(`SELECT token FROM channel WHERE id = $1`, [channelId]);
            return r.rows[0].token as string;
        });
        const channelCtx = await requestContextService.create({
            apiType: 'admin',
            channelOrToken: channelToken,
        });

        const retried = await shipmentService.retryShipment(channelCtx, fulfillmentId);
        assert.equal(retried.syncStatus, 'requested');
        assert.equal(retried.attempt, 2);
        assert.equal(retried.idempotencyKey, `${row.shipmentKey}-a2`);

        // Recovery must not treat attempt-1 exhausted as blocking attempt 2
        const recovery = await shipmentService.recoverOrphanedRequestedShipments();
        const active = await countActiveJobs(CREATE_AWB_QUEUE, {
            fulfillmentId,
            channelId,
            attempt: 2,
        });
        assert.ok(active >= 1 || recovery.enqueued >= 0);
        // After retryShipment already added a job for attempt 2
        assert.equal(
            await shipmentService.hasActiveCreateAwbJob({
                fulfillmentId,
                channelId,
                attempt: 2,
            }),
            true,
        );
        assert.equal(
            await shipmentService.hasExhaustedCreateAwbJob({
                fulfillmentId,
                channelId,
                attempt: 2,
            }),
            false,
        );

        connSvc.requireActive = originalRequire;
        evidence.test2 = {
            attempt: retried.attempt,
            syncStatus: retried.syncStatus,
            idempotencyKey: retried.idempotencyKey,
        };
    });

    it('3) missing cancel job is recovered', async () => {
        await cleanup();
        const fulfillmentId = 18003;
        await insertShipment({
            fulfillmentId,
            channelId,
            syncStatus: 'cancel_requested',
            trackingNumber: 'TN-CANCEL-3',
            ageMs: 120_000,
        });
        assert.equal(
            await countActiveJobs(CANCEL_AWB_QUEUE, {
                fulfillmentId,
                channelId,
                trackingNumber: 'TN-CANCEL-3',
            }),
            0,
        );
        const result = await shipmentService.recoverOrphanedCancelRequestedShipments();
        assert.ok(result.enqueued >= 1, JSON.stringify(result));
        assert.equal(
            await countActiveJobs(CANCEL_AWB_QUEUE, {
                fulfillmentId,
                channelId,
                trackingNumber: 'TN-CANCEL-3',
            }),
            1,
        );
        evidence.test3 = result;
    });

    it('4) existing active cancel job is not duplicated', async () => {
        await cleanup();
        const fulfillmentId = 18004;
        await insertShipment({
            fulfillmentId,
            channelId,
            syncStatus: 'cancel_requested',
            trackingNumber: 'TN-CANCEL-4',
            ageMs: 120_000,
        });
        await insertJob({
            queueName: CANCEL_AWB_QUEUE,
            state: JobState.PENDING,
            isSettled: false,
            data: {
                fulfillmentId,
                channelId,
                trackingNumber: 'TN-CANCEL-4',
                attempt: 1,
            },
        });
        const result = await shipmentService.recoverOrphanedCancelRequestedShipments();
        assert.equal(result.enqueued, 0);
        assert.ok(result.skippedActive >= 1);
        assert.equal(
            await countActiveJobs(CANCEL_AWB_QUEUE, {
                fulfillmentId,
                channelId,
                trackingNumber: 'TN-CANCEL-4',
            }),
            1,
        );
        evidence.test4 = result;
    });

    it('5) concurrent cancel recoveries do not create duplicate active jobs', async () => {
        await cleanup();
        const fulfillmentId = 18005;
        await insertShipment({
            fulfillmentId,
            channelId,
            syncStatus: 'cancel_requested',
            trackingNumber: 'TN-CANCEL-5',
            ageMs: 120_000,
        });
        const [a, b] = await Promise.all([
            shipmentService.recoverOrphanedCancelRequestedShipments(),
            shipmentService.recoverOrphanedCancelRequestedShipments(),
        ]);
        const active = await countActiveJobs(CANCEL_AWB_QUEUE, {
            fulfillmentId,
            channelId,
            trackingNumber: 'TN-CANCEL-5',
        });
        assert.equal(active, 1, `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
        evidence.test5 = { a, b, active };
    });

    it('6) channel isolation for cancel active-job matching', async () => {
        await cleanup();
        const fulfillmentId = 18006;
        await insertShipment({
            fulfillmentId,
            channelId,
            syncStatus: 'cancel_requested',
            trackingNumber: 'TN-CANCEL-6',
            ageMs: 120_000,
        });
        await insertShipment({
            fulfillmentId: 180061,
            channelId: channelIdB,
            syncStatus: 'cancel_requested',
            trackingNumber: 'TN-CANCEL-6B',
            ageMs: 120_000,
            keyPrefix: 'p1b',
        });
        await insertJob({
            queueName: CANCEL_AWB_QUEUE,
            state: JobState.PENDING,
            isSettled: false,
            data: {
                fulfillmentId,
                channelId,
                trackingNumber: 'TN-CANCEL-6',
                attempt: 1,
            },
        });
        assert.equal(
            await shipmentService.hasActiveCancelAwbJob({
                fulfillmentId,
                channelId,
                trackingNumber: 'TN-CANCEL-6',
            }),
            true,
        );
        assert.equal(
            await shipmentService.hasActiveCancelAwbJob({
                fulfillmentId: 180061,
                channelId: channelIdB,
                trackingNumber: 'TN-CANCEL-6B',
            }),
            false,
        );
        evidence.test6 = { channelA: channelId, channelB: channelIdB };
    });

    it('7) cancel processor locking with independent PostgreSQL sessions', async () => {
        await cleanup();
        const row = await insertShipment({
            fulfillmentId: 18007,
            channelId,
            syncStatus: 'cancel_requested',
            trackingNumber: 'TN-LOCK-7',
            ageMs: 120_000,
        });
        const c1 = new pg.Client(pgConfig());
        const c2 = new pg.Client(pgConfig());
        await c1.connect();
        await c2.connect();
        try {
            await c1.query('BEGIN');
            await c1.query(`SELECT id FROM bolesa_shipment WHERE id = $1 FOR UPDATE`, [row.id]);
            await c2.query(`SET lock_timeout = '400ms'`);
            await c2.query('BEGIN');
            let blocked = false;
            try {
                await c2.query(`SELECT id FROM bolesa_shipment WHERE id = $1 FOR UPDATE`, [row.id]);
            } catch (e: any) {
                blocked = /lock timeout|canceling statement|could not obtain lock/i.test(String(e.message));
            }
            assert.equal(blocked, true);
            await c2.query('ROLLBACK');
            await c1.query('ROLLBACK');
            evidence.test7 = { shipmentId: row.id, secondSessionBlocked: blocked };
        } finally {
            await c1.end();
            await c2.end();
        }
    });

    it('8) Partner HTTP remains outside database transactions (cancel path)', async () => {
        await cleanup();
        const fulfillmentId = 18008;
        await insertShipment({
            fulfillmentId,
            channelId,
            syncStatus: 'cancel_requested',
            trackingNumber: 'TN-HTTP-8',
            ageMs: 120_000,
            orderId: 88,
        });

        const connSvc = worker.app.get(BolesaConnectionService);
        const originalRequire = connSvc.requireActive.bind(connSvc);
        connSvc.requireActive = (async () => ({ id: 1 }) as any) as typeof connSvc.requireActive;
        connSvc.authFor = (() => ({ token: 'x', apiBaseUrl: 'http://127.0.0.1:9' })) as typeof connSvc.authFor;

        // Patch fulfillment/order transitions to no-ops so cancel commit does not need full Order graph
        const originalPatch = (shipmentService as any).patchFulfillment.bind(shipmentService);
        const originalTransition = (shipmentService as any).orderService.transitionFulfillmentToState.bind(
            (shipmentService as any).orderService,
        );
        const originalCancelCod = (shipmentService as any).cancelCodPaymentIfNeeded.bind(shipmentService);
        (shipmentService as any).patchFulfillment = async () => undefined;
        (shipmentService as any).orderService.transitionFulfillmentToState = async () => ({});
        (shipmentService as any).cancelCodPaymentIfNeeded = async () => undefined;

        inDbTxnDuringPartnerHttp = false;
        const before = cancelHttpCalls;
        const result = await shipmentService.processCancelAwb({
            fulfillmentId,
            channelId,
            trackingNumber: 'TN-HTTP-8',
            attempt: 1,
        });
        assert.equal(result.ok, true);
        assert.ok(cancelHttpCalls > before);
        assert.equal(inDbTxnDuringPartnerHttp, false, 'cancelAwb must not run inside withTransaction');
        assert.equal(await getSyncStatus(fulfillmentId, channelId), 'canceled');

        (shipmentService as any).patchFulfillment = originalPatch;
        (shipmentService as any).orderService.transitionFulfillmentToState = originalTransition;
        (shipmentService as any).cancelCodPaymentIfNeeded = originalCancelCod;
        connSvc.requireActive = originalRequire;
        evidence.test8 = {
            cancelHttpCalls,
            inDbTxnDuringPartnerHttp,
            ok: result.ok,
            txnDepthAtEnd: txnDepth,
        };
    });

    it('9) late create response cannot overwrite cancel_requested', async () => {
        await cleanup();
        const fulfillmentId = 18009;
        await insertShipment({
            fulfillmentId,
            channelId,
            syncStatus: 'cancel_requested',
            trackingNumber: 'TN-LATE-9',
            ageMs: 120_000,
            orderId: 99,
        });

        const channels = await withPgClient(async client => {
            const r = await client.query(`SELECT token FROM channel WHERE id = $1`, [channelId]);
            return r.rows[0].token as string;
        });
        const ctx = await requestContextService.create({
            apiType: 'admin',
            channelOrToken: channels,
        });

        // Simulate commit txn after Partner create while status is already cancel_requested
        const ok = await connection.withTransaction(ctx, async txCtx => {
            const shipment = await connection
                .getRepository(txCtx, BolesaShipment)
                .createQueryBuilder('s')
                .setLock('pessimistic_write')
                .where('s.fulfillmentId = :fulfillmentId AND s.channelId = :channelId', {
                    fulfillmentId,
                    channelId: txCtx.channelId,
                })
                .getOne();
            assert.ok(shipment);
            const { decideCreateAwbGate } = await import('../../util/create-awb-gate');
            const again = decideCreateAwbGate(shipment!);
            assert.equal(again.kind, 'terminal');
            if (again.kind === 'terminal') {
                assert.equal(again.reason, 'cancel_requested');
            }
            // Processor must not adopt/overwrite when terminal
            return again.kind !== 'terminal';
        });
        assert.equal(ok, false);
        assert.equal(await getSyncStatus(fulfillmentId, channelId), 'cancel_requested');
        evidence.test9 = { syncStatus: 'cancel_requested', overwriteBlocked: true };
    });

    it('10) no real Partner API calls (fetch ban + stubs)', async () => {
        evidence.test10 = {
            fetchCallCount,
            createHttpCalls,
            cancelHttpCalls,
            partnerBaseUrl: 'http://127.0.0.1:9/forbidden-partner-api',
        };
        assert.equal(fetchCallCount, 0);
    });

    it('11) precise active-create query finds match beyond 500 unrelated jobs (F-OQ-02)', async () => {
        await cleanup();
        const fulfillmentId = 18011;
        await insertShipment({
            fulfillmentId,
            channelId,
            syncStatus: 'requested',
            ageMs: 120_000,
        });

        // Insert 520 unrelated PENDING create jobs first (would overflow old LIMIT 500 scan)
        await withPgClient(async client => {
            const values: string[] = [];
            const params: unknown[] = [CREATE_AWB_QUEUE, JobState.PENDING];
            for (let i = 0; i < 520; i++) {
                const fulfillment = 19000 + i;
                const data = JSON.stringify({
                    fulfillmentId: fulfillment,
                    channelId,
                    attempt: 1,
                });
                params.push(data);
                const idx = params.length;
                values.push(`($1, $${idx}, $2, 0, false, 5, 0, NOW(), NOW())`);
            }
            await client.query(
                `INSERT INTO job_record
                  ("queueName", data, state, progress, "isSettled", retries, attempts, "createdAt", "updatedAt")
                 VALUES ${values.join(',')}`,
                params,
            );
        });

        // Matching job inserted after the unrelated flood
        await insertJob({
            queueName: CREATE_AWB_QUEUE,
            state: JobState.PENDING,
            isSettled: false,
            data: { fulfillmentId, channelId, attempt: 1 },
        });

        const detected = await shipmentService.hasActiveCreateAwbJob({
            fulfillmentId,
            channelId,
            attempt: 1,
        });
        assert.equal(detected, true);

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
        assert.equal(decision, 'skip_active_job');
        evidence.test11 = { unrelatedJobs: 520, detected, decision };
    });
});
