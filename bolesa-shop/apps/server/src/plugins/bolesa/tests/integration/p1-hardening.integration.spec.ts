/**
 * Phase 1.9 — Admin retry dedupe, cancel exhaustion, created-without-TN heal path.
 * vendure-bolesa-test only. No Partner API / outbound fetch.
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { JobState } from '@vendure/common/lib/generated-types';
import {
    bootstrapWorker,
    RequestContextService,
    VendureWorker,
} from '@vendure/core';
import pg, { Client as PgClient, ClientConfig as PgClientConfig } from 'pg';

import { CANCEL_AWB_QUEUE, CREATE_AWB_QUEUE } from '../../constants';
import { BolesaClient } from '../../services/bolesa-client.service';
import { BolesaConnectionService } from '../../services/bolesa-connection.service';
import { BolesaShipmentService } from '../../services/bolesa-shipment.service';
import { decideCreateAwbGate } from '../../util/create-awb-gate';
import { CANCEL_AWB_JOB_RETRIES, CREATE_AWB_JOB_RETRIES } from '../../util/outbox-recovery';
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

describe('Phase 1.9 hardening (vendure-bolesa-test)', () => {
    let worker: VendureWorker;
    let shipmentService: BolesaShipmentService;
    let requestContextService: RequestContextService;
    let channelId: number;
    let channelToken: string;
    let originalFetch: typeof globalThis.fetch;
    let createAwbCalls = 0;
    let findMetaCalls = 0;
    const evidence: Record<string, unknown> = {};

    before(async () => {
        assertTestDatabaseName(testConfig.dbConnectionOptions.database as string);
        originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
            throw new Error('SAFETY: outbound fetch forbidden');
        }) as typeof fetch;

        worker = await bootstrapWorker(testConfig);
        shipmentService = worker.app.get(BolesaShipmentService);
        requestContextService = worker.app.get(RequestContextService);

        const client = worker.app.get(BolesaClient);
        client.createAwb = (async () => {
            createAwbCalls += 1;
            throw new Error('SAFETY: createAwb blocked');
        }) as typeof client.createAwb;
        client.findAwbsByMeta = (async () => {
            findMetaCalls += 1;
            return [];
        }) as typeof client.findAwbsByMeta;
        client.cancelAwb = (async () => ({ status: 'canceled', refund: null })) as typeof client.cancelAwb;
        client.getAwb = (async () => null) as typeof client.getAwb;
        client.me = (async () => {
            throw new Error('SAFETY');
        }) as typeof client.me;
        client.searchCities = (async () => []) as typeof client.searchCities;
        client.serviceOptions = (async () => []) as typeof client.serviceOptions;

        const connSvc = worker.app.get(BolesaConnectionService);
        connSvc.requireActive = (async () =>
            ({
                id: 1,
                defaultServiceSlug: 'auto',
                markupPercent: 0,
                codFeeMode: 'absorb',
                shipmentCategory: 'dry',
            }) as any) as typeof connSvc.requireActive;
        connSvc.authFor = (() => ({ token: 'x', apiBaseUrl: 'http://127.0.0.1:9' })) as typeof connSvc.authFor;
        connSvc.getForChannel = (async () =>
            ({ lastVerifiedAt: new Date('2026-01-01T00:00:00Z') }) as any) as typeof connSvc.getForChannel;

        channelId = await ensureChannel('bolesa-p19-a', 'token-bolesa-p19-a');
        channelToken = await withPgClient(async c => {
            const r = await c.query(`SELECT token FROM channel WHERE id = $1`, [channelId]);
            return r.rows[0].token as string;
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
        if (originalFetch) {
            globalThis.fetch = originalFetch;
        }
        // eslint-disable-next-line no-console
        console.log('P1_HARDENING_EVIDENCE', JSON.stringify(evidence, null, 2));
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
                 VALUES ($1,$2,'en','EGP',false,'en','EGP',true,0,'bolesa p19')
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
            await client.query(`DELETE FROM job_record WHERE "queueName" LIKE 'bolesa%'`);
        });
        createAwbCalls = 0;
        findMetaCalls = 0;
    }

    async function insertShipment(opts: {
        fulfillmentId: number;
        syncStatus: string;
        attempt?: number;
        trackingNumber?: string | null;
        ageMs?: number;
    }): Promise<{ id: number; shipmentKey: string; attempt: number }> {
        const attempt = opts.attempt ?? 1;
        const shipmentKey = `p19-f${opts.fulfillmentId}-c${channelId}`;
        const ageMs = opts.ageMs ?? 120_000;
        return withPgClient(async client => {
            const res = await client.query<{ id: number }>(
                `INSERT INTO bolesa_shipment
                  ("fulfillmentId","orderId","channelId","shipmentKey","idempotencyKey",attempt,"syncStatus",
                   "trackingNumber","labelAvailability","codCollectionStatus","codRemittanceStatus","createdAt","updatedAt")
                 VALUES ($1,1,$2,$3,$4,$5,$6,$7,'unavailable','pending','unknown',
                         NOW() - ($8 || ' milliseconds')::interval,
                         NOW() - ($8 || ' milliseconds')::interval)
                 RETURNING id`,
                [
                    opts.fulfillmentId,
                    channelId,
                    shipmentKey,
                    `${shipmentKey}-a${attempt}`,
                    attempt,
                    opts.syncStatus,
                    opts.trackingNumber ?? null,
                    String(ageMs),
                ],
            );
            return { id: res.rows[0].id, shipmentKey, attempt };
        });
    }

    async function countActiveCreate(fulfillmentId: number, attempt: number): Promise<number> {
        return withPgClient(async client => {
            const res = await client.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM job_record
                 WHERE "queueName" = $1 AND state IN ('PENDING','RUNNING','RETRYING') AND "isSettled"=false
                   AND (data::json->>'fulfillmentId')=$2 AND (data::json->>'attempt')=$3`,
                [CREATE_AWB_QUEUE, String(fulfillmentId), String(attempt)],
            );
            return Number(res.rows[0].count);
        });
    }

    async function countActiveCancel(fulfillmentId: number, tn: string): Promise<number> {
        return withPgClient(async client => {
            const res = await client.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM job_record
                 WHERE "queueName" = $1 AND state IN ('PENDING','RUNNING','RETRYING') AND "isSettled"=false
                   AND (data::json->>'fulfillmentId')=$2 AND (data::json->>'trackingNumber')=$3`,
                [CANCEL_AWB_QUEUE, String(fulfillmentId), tn],
            );
            return Number(res.rows[0].count);
        });
    }

    async function ctx() {
        return requestContextService.create({ apiType: 'admin', channelOrToken: channelToken });
    }

    it('1) concurrent Admin retry bumps attempt once and does not duplicate jobs', async () => {
        await cleanup();
        const fulfillmentId = 19001;
        await insertShipment({ fulfillmentId, syncStatus: 'retry_exhausted', attempt: 1 });

        const channelCtx = await ctx();
        const [a, b] = await Promise.all([
            shipmentService.retryShipment(channelCtx, fulfillmentId),
            shipmentService.retryShipment(channelCtx, fulfillmentId),
        ]);

        const attempts = new Set([a.attempt, b.attempt]);
        assert.equal(attempts.size, 1, 'attempt bumped exactly once across concurrent retries');
        assert.equal([...attempts][0], 2);
        assert.equal(a.idempotencyKey, b.idempotencyKey);
        assert.equal(a.syncStatus, 'requested');

        const active = await countActiveCreate(fulfillmentId, 2);
        assert.equal(active, 1);
        evidence.test1 = { attempt: a.attempt, idempotencyKey: a.idempotencyKey, active };
    });

    it('2) Admin retry while active job is idempotent (no second bump)', async () => {
        await cleanup();
        const fulfillmentId = 19002;
        await insertShipment({ fulfillmentId, syncStatus: 'requested', attempt: 3, ageMs: 120_000 });
        await withPgClient(async client => {
            await client.query(
                `INSERT INTO job_record
                  ("queueName", data, state, progress, "isSettled", retries, attempts, "createdAt", "updatedAt")
                 VALUES ($1,$2,$3,0,false,5,0,NOW(),NOW())`,
                [
                    CREATE_AWB_QUEUE,
                    JSON.stringify({ fulfillmentId, channelId, attempt: 3 }),
                    JobState.PENDING,
                ],
            );
        });

        const channelCtx = await ctx();
        const before = await shipmentService.retryShipment(channelCtx, fulfillmentId);
        assert.equal(before.attempt, 3);
        assert.equal(await countActiveCreate(fulfillmentId, 3), 1);
        evidence.test2 = { attempt: before.attempt, active: 1 };
    });

    it('3) cancel exhaustion marks cancel_retry_exhausted and stops auto recovery', async () => {
        await cleanup();
        const fulfillmentId = 19003;
        const tn = 'TN-P19-3';
        await insertShipment({
            fulfillmentId,
            syncStatus: 'cancel_requested',
            trackingNumber: tn,
            ageMs: 120_000,
        });
        await withPgClient(async client => {
            await client.query(
                `INSERT INTO job_record
                  ("queueName", data, state, progress, "isSettled", retries, attempts, "createdAt", "updatedAt")
                 VALUES ($1,$2,$3,0,true,$4,$5,NOW(),NOW())`,
                [
                    CANCEL_AWB_QUEUE,
                    JSON.stringify({ fulfillmentId, channelId, trackingNumber: tn, attempt: 1 }),
                    JobState.FAILED,
                    CANCEL_AWB_JOB_RETRIES,
                    CANCEL_AWB_JOB_RETRIES + 1,
                ],
            );
        });

        const first = await shipmentService.recoverOrphanedCancelRequestedShipments();
        const status = await withPgClient(async client => {
            const r = await client.query(
                `SELECT "syncStatus" FROM bolesa_shipment WHERE "fulfillmentId"=$1 AND "channelId"=$2`,
                [fulfillmentId, channelId],
            );
            return r.rows[0].syncStatus as string;
        });
        assert.equal(status, 'cancel_retry_exhausted');
        assert.ok(first.markedExhausted >= 1);

        const second = await shipmentService.recoverOrphanedCancelRequestedShipments();
        assert.equal(second.enqueued, 0);
        assert.equal(await countActiveCancel(fulfillmentId, tn), 0);
        evidence.test3 = { first, second, status };
    });

    it('4) Admin cancel retry restores eligibility without duplicating active jobs', async () => {
        await cleanup();
        const fulfillmentId = 19004;
        const tn = 'TN-P19-4';
        await insertShipment({
            fulfillmentId,
            syncStatus: 'cancel_retry_exhausted',
            trackingNumber: tn,
        });

        const channelCtx = await ctx();
        const [a, b] = await Promise.all([
            shipmentService.retryCancelShipment(channelCtx, fulfillmentId),
            shipmentService.retryCancelShipment(channelCtx, fulfillmentId),
        ]);
        assert.equal(a.syncStatus, 'cancel_requested');
        assert.equal(b.syncStatus, 'cancel_requested');
        assert.equal(await countActiveCancel(fulfillmentId, tn), 1);
        evidence.test4 = { syncStatus: a.syncStatus, active: 1 };
    });

    it('5) created without TN is lookup-only (empty findAwbs → no createAwb)', async () => {
        await cleanup();
        const fulfillmentId = 19005;
        const row = await insertShipment({
            fulfillmentId,
            syncStatus: 'created',
            trackingNumber: null,
            attempt: 1,
        });

        const gate = decideCreateAwbGate({
            syncStatus: 'created',
            trackingNumber: null,
            shipmentKey: row.shipmentKey,
            idempotencyKey: `${row.shipmentKey}-a1`,
            orderId: '1',
            attempt: 1,
        });
        assert.equal(gate.kind, 'awaiting_lookup');

        const channelCtx = await ctx();
        const beforeCreate = createAwbCalls;
        const beforeMeta = findMetaCalls;
        const result = await shipmentService.createAwbForFulfillment(channelCtx, fulfillmentId);
        assert.equal(result.ok, true);
        assert.equal(createAwbCalls, beforeCreate, 'must not POST /awbs');
        assert.ok(findMetaCalls > beforeMeta, 'must attempt meta lookup');
        evidence.test5 = {
            gate: gate.kind,
            createAwbCalls: createAwbCalls - beforeCreate,
            findMetaCalls: findMetaCalls - beforeMeta,
            ok: result.ok,
        };
    });

    it('6) ops health returns channel counts without Partner calls', async () => {
        await cleanup();
        await insertShipment({ fulfillmentId: 19006, syncStatus: 'failed' });
        await insertShipment({ fulfillmentId: 19007, syncStatus: 'retry_exhausted' });

        const channelCtx = await ctx();
        const health = await shipmentService.getOpsHealth(channelCtx);
        assert.ok(health.channels[0].failed >= 1);
        assert.ok(health.channels[0].retryExhausted >= 1);
        assert.ok(health.queues.length >= 2);
        assert.ok(health.notes.length > 0);
        evidence.test6 = {
            failed: health.channels[0].failed,
            retryExhausted: health.channels[0].retryExhausted,
            lastPartnerVerifiedAt: health.lastPartnerVerifiedAt,
        };
    });

    it('7) EXPLAIN active-create JSON filter (capacity evidence, no index added)', async () => {
        const plan = await withPgClient(async client => {
            const res = await client.query(
                `EXPLAIN (FORMAT TEXT)
                 SELECT id FROM job_record
                 WHERE "queueName" = $1
                   AND state = ANY($2::text[])
                   AND "isSettled" = false
                   AND (data::json->>'fulfillmentId') = $3
                   AND (data::json->>'channelId') = $4
                   AND (data::json->>'attempt') = $5
                 LIMIT 1`,
                [CREATE_AWB_QUEUE, ['PENDING', 'RUNNING', 'RETRYING'], '1', '1', '1'],
            );
            return res.rows.map((r: Record<string, unknown>) => String(r['QUERY PLAN'] ?? '')).join('\n');
        });
        // Document only — do not add index without scale evidence showing seq-scan pain.
        evidence.test7 = { planSnippet: plan.slice(0, 500), indexAdded: false };
        assert.ok(plan.length > 0);
    });
});
