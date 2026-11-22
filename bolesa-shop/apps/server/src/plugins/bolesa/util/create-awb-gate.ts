import { ID } from '@vendure/core';

import { BolesaShipmentSyncStatus } from '../types';

export interface CreateAwbGateShipment {
    syncStatus: BolesaShipmentSyncStatus | string;
    trackingNumber?: string | null;
    shipmentKey: string;
    idempotencyKey: string;
    orderId: ID;
    attempt: number;
}

export type CreateAwbGateDecision =
    | { kind: 'done'; trackingNumber: string }
    | {
          kind: 'terminal';
          reason:
              | 'abandoned'
              | 'canceled'
              | 'failed'
              | 'retry_exhausted'
              | 'cancel_requested'
              | 'cancel_retry_exhausted';
      }
    /**
     * Lookup/reconcile only — never POST /awbs.
     * Used for `awaiting_bolesa` and anomalous `created` without trackingNumber.
     */
    | {
          kind: 'awaiting_lookup';
          shipmentKey: string;
          idempotencyKey: string;
          orderId: ID;
          attempt: number;
      }
    | {
          kind: 'proceed';
          shipmentKey: string;
          idempotencyKey: string;
          orderId: ID;
          attempt: number;
      };

/**
 * Explicit syncStatus gate for create-AWB processing.
 * Admin retry sets status back to `requested` before enqueue — that path still uses `proceed`.
 *
 * `created` without trackingNumber never blindly POSTs: heal via meta lookup only.
 * Another create requires Admin retry → `requested`.
 */
export function decideCreateAwbGate(shipment: CreateAwbGateShipment): CreateAwbGateDecision {
    const status = String(shipment.syncStatus);

    if (status === 'created' && shipment.trackingNumber) {
        return { kind: 'done', trackingNumber: String(shipment.trackingNumber) };
    }

    if (
        status === 'abandoned' ||
        status === 'canceled' ||
        status === 'failed' ||
        status === 'retry_exhausted' ||
        status === 'cancel_retry_exhausted'
    ) {
        return {
            kind: 'terminal',
            reason: status as
                | 'abandoned'
                | 'canceled'
                | 'failed'
                | 'retry_exhausted'
                | 'cancel_retry_exhausted',
        };
    }

    if (status === 'cancel_requested') {
        return { kind: 'terminal', reason: 'cancel_requested' };
    }

    if (status === 'awaiting_bolesa' || (status === 'created' && !shipment.trackingNumber)) {
        // Lookup-only heal path — never POST /awbs without Admin re-request.
        return {
            kind: 'awaiting_lookup',
            shipmentKey: shipment.shipmentKey,
            idempotencyKey: shipment.idempotencyKey,
            orderId: shipment.orderId,
            attempt: shipment.attempt,
        };
    }

    if (status === 'requested') {
        return {
            kind: 'proceed',
            shipmentKey: shipment.shipmentKey,
            idempotencyKey: shipment.idempotencyKey,
            orderId: shipment.orderId,
            attempt: shipment.attempt,
        };
    }

    // Unknown status: do not create
    return { kind: 'terminal', reason: 'failed' };
}

/** Reject fabricated placeholders used by the pre-fix outbox path. */
export function isValidPersistedOrderId(orderId: ID | string | null | undefined): boolean {
    if (orderId == null) {
        return false;
    }
    const s = String(orderId).trim();
    return s !== '' && s !== '0';
}
