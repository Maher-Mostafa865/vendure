import { Logger, ScheduledTask } from '@vendure/core';

import { loggerCtx } from '../constants';
import { BolesaShipmentService } from './bolesa-shipment.service';

/**
 * Polls open Bolesa shipments and applies forward-only status updates.
 * Webhooks are Phase 2 — reconciliation is mandatory in Phase 1.
 */
export const bolesaReconcileTask = new ScheduledTask({
    id: 'bolesa-reconcile-shipments',
    description: 'Reconcile Bolesa AWB statuses via Partner API polling',
    schedule: cron => cron.every(15).minutes(),
    async execute({ injector }) {
        const shipmentService = injector.get(BolesaShipmentService);
        try {
            const result = await shipmentService.reconcileOpenShipments();
            Logger.debug(`Bolesa reconcile checked ${result.checked} shipments`, loggerCtx);
            return result;
        } catch (e: any) {
            Logger.error(`Bolesa reconcile failed: ${e?.message}`, loggerCtx);
            throw e;
        }
    },
});
