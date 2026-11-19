/**
 * Structured ops metric helpers. Logs never include tokens, addresses, or customer PII.
 */

export interface BolesaChannelHealthCounts {
    channelId: string;
    bySyncStatus: Record<string, number>;
    stuckRequested: number;
    stuckCancelRequested: number;
    failed: number;
    retryExhausted: number;
    cancelRetryExhausted: number;
}

export interface BolesaQueueHealth {
    queueName: string;
    active: number;
    failedUnsettledLike: number;
}

export interface BolesaOpsSnapshot {
    generatedAt: string;
    stuckThresholdMs: number;
    channels: BolesaChannelHealthCounts[];
    queues: BolesaQueueHealth[];
    lastPartnerVerifiedAt: string | null;
    notes: string[];
}

export function formatOpsMetricLine(
    name: string,
    fields: Record<string, string | number | boolean | null | undefined>,
): string {
    const parts = Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v === null ? 'null' : String(v)}`);
    return `BolesaMetric ${name} ${parts.join(' ')}`;
}
