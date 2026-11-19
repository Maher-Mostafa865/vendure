import { JobState } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/core';

import { BolesaShipmentSyncStatus, CreateAwbJobData } from '../types';

/** Grace before treating a `requested` row as orphaned (avoids racing the happy-path enqueue). */
export const ORPHAN_CREATE_JOB_GRACE_MS = 60_000;

/** JobQueue states that mean a create-AWB job is still in flight. */
export const ACTIVE_CREATE_JOB_STATES: readonly JobState[] = [
    JobState.PENDING,
    JobState.RUNNING,
    JobState.RETRYING,
];

export type CreateJobEnqueueDecision = 'enqueue' | 'skip_status' | 'skip_active_job' | 'skip_grace';

export interface CreateJobIdentity {
    fulfillmentId: ID;
    channelId: ID;
    attempt: number;
}

export interface CreateJobCandidate extends CreateJobIdentity {
    syncStatus: BolesaShipmentSyncStatus | string;
    updatedAt?: Date | string | null;
}

export interface JobLike {
    state: JobState | string;
    data?: Partial<CreateAwbJobData> | null;
}

/**
 * Decide whether recovery/event handling should add a `bolesa-create-awb` job.
 * Does not bump attempts or change idempotency keys — callers must keep those stable.
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

/**
 * Match a JobQueue payload to a shipment. Attempt must match so a newer admin-retry
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

export function hasActiveEquivalentCreateJob(
    jobs: readonly JobLike[],
    shipment: CreateJobIdentity,
): boolean {
    return jobs.some(job => isActiveCreateJobState(job.state) && jobMatchesShipment(job, shipment));
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
