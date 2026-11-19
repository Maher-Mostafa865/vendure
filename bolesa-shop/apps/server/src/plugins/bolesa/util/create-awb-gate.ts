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
    | { kind: 'terminal'; reason: 'abandoned' | 'canceled' | 'failed' | 'cancel_requested' }
    /** Partner already accepted create asynchronously — lookup/reconcile only, never POST /awbs again. */
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
 */
export function decideCreateAwbGate(shipment: CreateAwbGateShipment): CreateAwbGateDecision {
    const status = String(shipment.syncStatus);

    if (status === 'created' && shipment.trackingNumber) {
        return { kind: 'done', trackingNumber: String(shipment.trackingNumber) };
    }

    if (status === 'abandoned' || status === 'canceled' || status === 'failed') {
        return { kind: 'terminal', reason: status };
    }

    if (status === 'cancel_requested') {
        return { kind: 'terminal', reason: 'cancel_requested' };
    }

    if (status === 'awaiting_bolesa') {
        return {
            kind: 'awaiting_lookup',
            shipmentKey: shipment.shipmentKey,
            idempotencyKey: shipment.idempotencyKey,
            orderId: shipment.orderId,
            attempt: shipment.attempt,
        };
    }

    // requested (and any unexpected non-terminal status treated as create-eligible)
    if (status === 'requested' || status === 'created') {
        // created without TN is anomalous — allow proceed so pre-check/adopt can heal
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
