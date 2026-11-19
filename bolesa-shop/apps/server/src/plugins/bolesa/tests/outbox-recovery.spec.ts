import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JobState } from '@vendure/common/lib/generated-types';

import { BolesaApiError } from '../services/bolesa-client.service';
import {
    ACTIVE_CREATE_JOB_STATES,
    classifyCreateAwbHttpFailure,
    decideCreateJobEnqueue,
    hasActiveEquivalentCreateJob,
    isPastOrphanGrace,
    jobMatchesShipment,
    ORPHAN_CREATE_JOB_GRACE_MS,
} from '../util/outbox-recovery';

const baseShipment = {
    fulfillmentId: '10',
    channelId: '1',
    attempt: 1,
    syncStatus: 'requested' as const,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('outbox recovery decisions', () => {
    it('enqueues orphaned requested shipment when no active job and past grace', () => {
        const decision = decideCreateJobEnqueue({
            shipment: baseShipment,
            hasActiveEquivalentJob: false,
            now: new Date(baseShipment.updatedAt.getTime() + ORPHAN_CREATE_JOB_GRACE_MS + 1),
        });
        assert.equal(decision, 'enqueue');
    });

    it('does not enqueue when an equivalent active job already exists', () => {
        const decision = decideCreateJobEnqueue({
            shipment: baseShipment,
            hasActiveEquivalentJob: true,
            ignoreGracePeriod: true,
        });
        assert.equal(decision, 'skip_active_job');
    });

    it('repeated recovery is idempotent while an active job exists', () => {
        const first = decideCreateJobEnqueue({
            shipment: baseShipment,
            hasActiveEquivalentJob: false,
            ignoreGracePeriod: true,
        });
        const second = decideCreateJobEnqueue({
            shipment: baseShipment,
            hasActiveEquivalentJob: true,
            ignoreGracePeriod: true,
        });
        assert.equal(first, 'enqueue');
        assert.equal(second, 'skip_active_job');
    });

    it('skips permanent failed status (no automatic 4xx retry)', () => {
        const decision = decideCreateJobEnqueue({
            shipment: { ...baseShipment, syncStatus: 'failed' },
            hasActiveEquivalentJob: false,
            ignoreGracePeriod: true,
        });
        assert.equal(decision, 'skip_status');
    });

    it('skips created / abandoned / canceled / awaiting_bolesa', () => {
        for (const syncStatus of ['created', 'abandoned', 'canceled', 'awaiting_bolesa', 'cancel_requested']) {
            const decision = decideCreateJobEnqueue({
                shipment: { ...baseShipment, syncStatus },
                hasActiveEquivalentJob: false,
                ignoreGracePeriod: true,
            });
            assert.equal(decision, 'skip_status', syncStatus);
        }
    });

    it('respects orphan grace unless ignored (fulfillment event path)', () => {
        const now = new Date(baseShipment.updatedAt.getTime() + 1_000);
        assert.equal(
            decideCreateJobEnqueue({
                shipment: baseShipment,
                hasActiveEquivalentJob: false,
                now,
            }),
            'skip_grace',
        );
        assert.equal(
            decideCreateJobEnqueue({
                shipment: baseShipment,
                hasActiveEquivalentJob: false,
                now,
                ignoreGracePeriod: true,
            }),
            'enqueue',
        );
    });

    it('concurrent recovery: only the first enqueue wins when active job appears', () => {
        const jobs: Array<{ state: JobState; data: typeof baseShipment }> = [];
        const tryRecover = () => {
            const hasActive = hasActiveEquivalentCreateJob(jobs, baseShipment);
            const decision = decideCreateJobEnqueue({
                shipment: baseShipment,
                hasActiveEquivalentJob: hasActive,
                ignoreGracePeriod: true,
            });
            if (decision === 'enqueue') {
                jobs.push({
                    state: JobState.PENDING,
                    data: {
                        fulfillmentId: baseShipment.fulfillmentId,
                        channelId: baseShipment.channelId,
                        attempt: baseShipment.attempt,
                        syncStatus: 'requested',
                        updatedAt: baseShipment.updatedAt,
                    },
                });
            }
            return decision;
        };
        assert.equal(tryRecover(), 'enqueue');
        assert.equal(tryRecover(), 'skip_active_job');
        assert.equal(jobs.length, 1);
    });
});

describe('active create-job matching', () => {
    it('matches PENDING/RUNNING/RETRYING for same fulfillment+channel+attempt', () => {
        for (const state of ACTIVE_CREATE_JOB_STATES) {
            assert.equal(
                hasActiveEquivalentCreateJob(
                    [
                        {
                            state,
                            data: {
                                fulfillmentId: '10',
                                channelId: '1',
                                attempt: 1,
                            },
                        },
                    ],
                    baseShipment,
                ),
                true,
                String(state),
            );
        }
    });

    it('ignores completed/failed/cancelled jobs', () => {
        for (const state of [JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED]) {
            assert.equal(
                hasActiveEquivalentCreateJob(
                    [
                        {
                            state,
                            data: {
                                fulfillmentId: '10',
                                channelId: '1',
                                attempt: 1,
                            },
                        },
                    ],
                    baseShipment,
                ),
                false,
                String(state),
            );
        }
    });

    it('does not match a different channel (channel isolation)', () => {
        assert.equal(
            jobMatchesShipment(
                {
                    state: JobState.PENDING,
                    data: { fulfillmentId: '10', channelId: '99', attempt: 1 },
                },
                baseShipment,
            ),
            false,
        );
    });

    it('does not treat a stale attempt job as equivalent to a newer attempt', () => {
        assert.equal(
            jobMatchesShipment(
                {
                    state: JobState.PENDING,
                    data: { fulfillmentId: '10', channelId: '1', attempt: 1 },
                },
                { ...baseShipment, attempt: 2 },
            ),
            false,
        );
    });
});

describe('orphan grace helpers', () => {
    it('isPastOrphanGrace becomes true after the configured window', () => {
        const updatedAt = new Date('2026-01-01T00:00:00.000Z');
        assert.equal(isPastOrphanGrace(updatedAt, new Date(updatedAt.getTime() + 59_999)), false);
        assert.equal(isPastOrphanGrace(updatedAt, new Date(updatedAt.getTime() + 60_000)), true);
    });
});

describe('create AWB HTTP failure classification (worker retry vs permanent)', () => {
    it('classifies 409 and 5xx as retryable (JobQueue should retry; same idempotency key)', () => {
        assert.equal(classifyCreateAwbHttpFailure(409), 'retry');
        assert.equal(classifyCreateAwbHttpFailure(500), 'retry');
        assert.equal(classifyCreateAwbHttpFailure(503), 'retry');
        assert.equal(new BolesaApiError('conflict', 'x', 409).isRetryable, true);
        assert.equal(new BolesaApiError('upstream', 'x', 502).isRetryable, true);
    });

    it('classifies definitive 4xx as permanent (outbox failed; recovery must not re-enqueue)', () => {
        assert.equal(classifyCreateAwbHttpFailure(400), 'permanent');
        assert.equal(classifyCreateAwbHttpFailure(422), 'permanent');
        const err = new BolesaApiError('validation_error', 'bad address', 422);
        assert.equal(err.isDefiniteFailure, true);
        assert.equal(err.isRetryable, false);
        assert.equal(
            decideCreateJobEnqueue({
                shipment: { ...baseShipment, syncStatus: 'failed' },
                hasActiveEquivalentJob: false,
                ignoreGracePeriod: true,
            }),
            'skip_status',
        );
    });
});

describe('duplicate FulfillmentEvent handling policy', () => {
    it('only requested shipments are eligible for re-enqueue on duplicate events', () => {
        assert.equal(
            decideCreateJobEnqueue({
                shipment: { ...baseShipment, syncStatus: 'requested' },
                hasActiveEquivalentJob: false,
                ignoreGracePeriod: true,
            }),
            'enqueue',
        );
        assert.equal(
            decideCreateJobEnqueue({
                shipment: { ...baseShipment, syncStatus: 'created' },
                hasActiveEquivalentJob: false,
                ignoreGracePeriod: true,
            }),
            'skip_status',
        );
    });
});

describe('pessimistic lock transaction requirement', () => {
    it('documents that FOR UPDATE must run inside withTransaction (call-order contract)', async () => {
        const calls: string[] = [];
        const fakeConnection = {
            async withTransaction<T>(_ctx: unknown, work: (ctx: unknown) => Promise<T>): Promise<T> {
                calls.push('withTransaction:begin');
                const result = await work({ channelId: '1' });
                calls.push('withTransaction:end');
                return result;
            },
            getRepository() {
                return {
                    createQueryBuilder() {
                        return {
                            setLock(mode: string) {
                                calls.push(`setLock:${mode}`);
                                return this;
                            },
                            where() {
                                return this;
                            },
                            async getOne() {
                                calls.push('getOne');
                                return { syncStatus: 'created', trackingNumber: 'TN-1' };
                            },
                        };
                    },
                };
            },
        };

        // Mirrors lockShipmentForFulfillment usage inside createAwbForFulfillment gate.
        await fakeConnection.withTransaction({}, async ctx => {
            await fakeConnection
                .getRepository()
                .createQueryBuilder()
                .setLock('pessimistic_write')
                .where()
                .getOne();
            return ctx;
        });

        assert.deepEqual(calls, [
            'withTransaction:begin',
            'setLock:pessimistic_write',
            'getOne',
            'withTransaction:end',
        ]);
    });
});
