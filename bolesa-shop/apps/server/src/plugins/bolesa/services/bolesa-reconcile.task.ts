import { Logger, ScheduledTask } from '@vendure/core';

import { loggerCtx } from '../constants';
import { formatOpsMetricLine } from '../util/ops-metrics';
import { BolesaShipmentService } from './bolesa-shipment.service';

/**
 * Recovers orphaned create/cancel outbox rows (no Partner API), then polls open
 * shipments for forward-only status updates. Webhooks are Phase 2.
 */
export const bolesaReconcileTask = new ScheduledTask({
    id: 'bolesa-reconcile-shipments',
    description: 'Recover orphaned Bolesa create/cancel jobs and reconcile AWB statuses',
    schedule: cron => cron.every(15).minutes(),
    async execute({ injector }) {
        const shipmentService = injector.get(BolesaShipmentService);
        try {
            const result = await shipmentService.reconcileOpenShipments();
            Logger.debug(
                `Bolesa reconcile: createRecovered=${result.recovered}/${result.recoveryScanned} ` +
                    `exhausted=${result.markedExhausted} cancelExhausted=${result.cancelMarkedExhausted} ` +
                    `cancelRecovered=${result.cancelRecovered}/${result.cancelRecoveryScanned} ` +
                    `checked=${result.checked} batches=${result.batches} durationMs=${result.durationMs}`,
                loggerCtx,
            );
            return result;
        } catch (e: any) {
            // Stable metric line for external alerting (no PII).
            Logger.error(
                formatOpsMetricLine('reconcile_failed', {
                    errorClass: e?.name ?? 'Error',
                    message: String(e?.message ?? e).slice(0, 200),
                }),
                loggerCtx,
            );
            throw e;
        }
    },
});
