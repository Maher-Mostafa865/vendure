import { JobState } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/core';

import { BolesaShipmentSyncStatus, CancelAwbJobData, CreateAwbJobData } from '../types';

/** Grace before treating a `requested` row as orphaned (avoids racing the happy-path enqueue). */
export const ORPHAN_CREATE_JOB_GRACE_MS = 60_000;

/** Grace before treating a `cancel_requested` row as orphaned. */
export const ORPHAN_CANCEL_JOB_GRACE_MS = 60_000;

/** Must match `{ retries: N }` passed to createQueue.add. */
export const CREATE_AWB_JOB_RETRIES = 5;

/** Must match `{ retries: N }` passed to cancelQueue.add. */
export const CANCEL_AWB_JOB_RETRIES = 5;

/** JobQueue states that mean a create/cancel job is still in flight. */
export const ACTIVE_CREATE_JOB_STATES: readonly JobState[] = [
    JobState.PENDING,
    JobState.RUNNING,
    JobState.RETRYING,
];

export const ACTIVE_CANCEL_JOB_STATES: readonly JobState[] = ACTIVE_CREATE_JOB_STATES;

export type CreateJobEnqueueDecision =
    | 'enqueue'
    | 'skip_status'
    | 'skip_active_job'
    | 'skip_grace'
    | 'mark_exhausted';

export type CancelJobEnqueueDecision =
    | 'enqueue'
    | 'skip_status'
    | 'skip_active_job'
    | 'skip_grace'
    | 'skip_exhausted';

export interface CreateJobIdentity {
    fulfillmentId: ID;
    channelId: ID;
    attempt: number;
}

export interface CancelJobIdentity {
    fulfillmentId: ID;
    channelId: ID;
    trackingNumber: string;
}

export interface CreateJobCandidate extends CreateJobIdentity {
    syncStatus: BolesaShipmentSyncStatus | string;
    updatedAt?: Date | string | null;
}

export interface CancelJobCandidate extends CancelJobIdentity {
    syncStatus: BolesaShipmentSyncStatus | string;
    updatedAt?: Date | string | null;
}

export interface JobLike {
    state: JobState | string;
    data?: Partial<CreateAwbJobData> | null;
}

export interface CancelJobLike {
    state: JobState | string;
    data?: Partial<CancelAwbJobData> | null;
}

export interface ExhaustedJobLike {
    state: JobState | string;
    isSettled?: boolean;
    attempts: number;
    retries: number;
}

/**
 * Decide whether recovery/event handling should add a `bolesa-create-awb` job.
 * Does not bump attempts or change idempotency keys — callers must keep those stable.
 * Exhausted detection is handled by the caller (`mark_exhausted`) before this helper.
 */
export function decideCreateJobEnqueue(args: {
    shipment: CreateJobCandidate;
    hasActiveEquivalentJob: boolean;
    /** When true (e.g. FulfillmentEvent path), skip the orphan grace window. */
    ignoreGracePeriod?: boolean;
    now?: Date;
    graceMs?: number;
}): CreateJobEnqueueDecision {
    if (args.shipment.syncStatus !== 'requested') {
        return 'skip_status';
    }
    if (args.hasActiveEquivalentJob) {
        return 'skip_active_job';
    }
    if (!args.ignoreGracePeriod) {
        const graceMs = args.graceMs ?? ORPHAN_CREATE_JOB_GRACE_MS;
        if (!isPastOrphanGrace(args.shipment.updatedAt, args.now ?? new Date(), graceMs)) {
            return 'skip_grace';
        }
    }
    return 'enqueue';
}

/**
 * Decide whether recovery should add a `bolesa-cancel-awb` job.
 * Only `cancel_requested` is eligible. Explicit Admin/order cancel may pass ignoreExhausted upstream.
 */
export function decideCancelJobEnqueue(args: {
    shipment: CancelJobCandidate;
    hasActiveEquivalentJob: boolean;
    hasExhaustedJob: boolean;
    ignoreGracePeriod?: boolean;
    /** Explicit cancel request may re-enqueue after prior exhaustion. */
    ignoreExhausted?: boolean;
    now?: Date;
    graceMs?: number;
}): CancelJobEnqueueDecision {
    if (args.shipment.syncStatus !== 'cancel_requested') {
        return 'skip_status';
    }
    if (!args.shipment.trackingNumber) {
        return 'skip_status';
    }
    if (args.hasActiveEquivalentJob) {
        return 'skip_active_job';
    }
    if (args.hasExhaustedJob && !args.ignoreExhausted) {
        return 'skip_exhausted';
    }
    if (!args.ignoreGracePeriod) {
        const graceMs = args.graceMs ?? ORPHAN_CANCEL_JOB_GRACE_MS;
        if (!isPastOrphanGrace(args.shipment.updatedAt, args.now ?? new Date(), graceMs)) {
            return 'skip_grace';
        }
    }
    return 'enqueue';
}

export function isPastOrphanGrace(
    updatedAt: Date | string | null | undefined,
    now: Date = new Date(),
    graceMs: number = ORPHAN_CREATE_JOB_GRACE_MS,
): boolean {
    if (!updatedAt) {
        return true;
    }
    const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
    if (Number.isNaN(ts)) {
        return true;
    }
    return now.getTime() - ts >= graceMs;
}

export function isActiveCreateJobState(state: JobState | string): boolean {
    return (ACTIVE_CREATE_JOB_STATES as readonly string[]).includes(String(state));
}

export function isActiveCancelJobState(state: JobState | string): boolean {
    return (ACTIVE_CANCEL_JOB_STATES as readonly string[]).includes(String(state));
}

/**
 * Match a create JobQueue payload to a shipment. Attempt must match so a newer admin-retry
 * attempt is not suppressed by a stale in-flight job for an older attempt.
 */
export function jobMatchesShipment(job: JobLike, shipment: CreateJobIdentity): boolean {
    const data = job.data;
    if (!data) {
        return false;
    }
    return (
        String(data.fulfillmentId) === String(shipment.fulfillmentId) &&
        String(data.channelId) === String(shipment.channelId) &&
        Number(data.attempt) === Number(shipment.attempt)
    );
}

export function jobMatchesCancelShipment(job: CancelJobLike, shipment: CancelJobIdentity): boolean {
    const data = job.data;
    if (!data?.trackingNumber) {
        return false;
    }
    return (
        String(data.fulfillmentId) === String(shipment.fulfillmentId) &&
        String(data.channelId) === String(shipment.channelId) &&
        String(data.trackingNumber) === String(shipment.trackingNumber)
    );
}

export function hasActiveEquivalentCreateJob(
    jobs: readonly JobLike[],
    shipment: CreateJobIdentity,
): boolean {
    return jobs.some(job => isActiveCreateJobState(job.state) && jobMatchesShipment(job, shipment));
}

export function hasActiveEquivalentCancelJob(
    jobs: readonly CancelJobLike[],
    shipment: CancelJobIdentity,
): boolean {
    return jobs.some(job => isActiveCancelJobState(job.state) && jobMatchesCancelShipment(job, shipment));
}

/**
 * Vendure JobQueue: on start, attempts++; on fail, retries if `retries >= attempts`.
 * Final failure settles FAILED when `attempts > retries`.
 */
export function isExhaustedJobRecord(job: ExhaustedJobLike): boolean {
    if (String(job.state) !== JobState.FAILED && String(job.state) !== 'FAILED') {
        return false;
    }
    return Number(job.attempts) > Number(job.retries);
}

/** True when the current process invocation is the last allowed attempt. */
export function isLastJobAttempt(job: { attempts: number; retries: number }): boolean {
    return Number(job.attempts) > Number(job.retries);
}

/**
 * Classify Partner create-AWB failures for JobQueue vs permanent outbox failure.
 * Mirrors BolesaApiError.isRetryable / isDefiniteFailure.
 */
export function classifyCreateAwbHttpFailure(status: number): 'retry' | 'permanent' | 'other' {
    if (status === 409 || status >= 500) {
        return 'retry';
    }
    if (status >= 400 && status < 500) {
        return 'permanent';
    }
    return 'other';
}

/**
 * Parse job_record.data which Vendure stores as JSON text (sometimes already parsed by drivers).
 */
export function parseJobRecordData<T extends Record<string, unknown>>(data: unknown): T | null {
    if (data == null) {
        return null;
    }
    if (typeof data === 'object') {
        return data as T;
    }
    if (typeof data === 'string') {
        try {
            return JSON.parse(data) as T;
        } catch {
            return null;
        }
    }
    return null;
}
