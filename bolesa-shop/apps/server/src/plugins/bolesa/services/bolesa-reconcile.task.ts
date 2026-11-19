import { Logger, ScheduledTask } from '@vendure/core';

import { loggerCtx } from '../constants';
import { BolesaShipmentService } from './bolesa-shipment.service';

/**
 * Recovers orphaned `requested` outbox rows (no Partner API), then polls open
 * shipments for forward-only status updates. Webhooks are Phase 2.
 */
export const bolesaReconcileTask = new ScheduledTask({
    id: 'bolesa-reconcile-shipments',
    description: 'Recover orphaned Bolesa create jobs and reconcile AWB statuses',
    schedule: cron => cron.every(15).minutes(),
    async execute({ injector }) {
        const shipmentService = injector.get(BolesaShipmentService);
        try {
            const result = await shipmentService.reconcileOpenShipments();
            Logger.debug(
                `Bolesa reconcile: recovered=${result.recovered}/${result.recoveryScanned} orphans, checked=${result.checked} open`,
                loggerCtx,
            );
            return result;
        } catch (e: any) {
            Logger.error(`Bolesa reconcile failed: ${e?.message}`, loggerCtx);
            throw e;
        }
    },
});
