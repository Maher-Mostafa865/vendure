/**
 * Forward-only mapping from Bolesa TrackingStatusEnum values to Vendure fulfillment actions.
 * Fine-grained status is always stored on customFields.bolesaStatus.
 */

export type VendureFulfillmentTarget = 'Shipped' | 'Delivered' | 'Cancelled' | 'Returned' | null;

const RANK: Record<string, number> = {
    'NO STATUS': 0,
    'READY FOR SHIPMENT': 10,
    'PICKED UP': 20,
    'IN TRANSIT': 30,
    'OUT FOR DELIVERY': 40,
    'TRIAL FAILURE': 45,
    'DELIVERY FAILURE': 45,
    ABNORMAL: 45,
    'LOST DAMAGED': 45,
    COMPENSATED: 45,
    'OTHER STATUS': 45,
    DELIVERED: 60,
    RETURNING: 55,
    'RETURN PROCESS STARTED': 55,
    RETURNED: 70,
    CANCELED: 80,
};

export function statusRank(status: string | null | undefined): number {
    if (!status) {
        return -1;
    }
    return RANK[status.toUpperCase()] ?? 0;
}

/**
 * Returns the next Vendure fulfillment state to attempt, or null if only customFields should update.
 * Never suggests a backward Vendure transition — caller must still check current state.
 */
export function mapBolesaStatusToFulfillmentTarget(status: string): VendureFulfillmentTarget {
    const s = status.toUpperCase();
    switch (s) {
        case 'PICKED UP':
        case 'IN TRANSIT':
        case 'OUT FOR DELIVERY':
        case 'TRIAL FAILURE':
        case 'DELIVERY FAILURE':
            return 'Shipped';
        case 'DELIVERED':
            return 'Delivered';
        case 'RETURNED':
            return 'Returned';
        case 'CANCELED':
            return 'Cancelled';
        case 'RETURNING':
        case 'RETURN PROCESS STARTED':
        case 'READY FOR SHIPMENT':
        case 'ABNORMAL':
        case 'LOST DAMAGED':
        case 'COMPENSATED':
        case 'NO STATUS':
        case 'OTHER STATUS':
        default:
            return null;
    }
}

export function isTerminalBolesaStatus(status: string | null | undefined): boolean {
    if (!status) {
        return false;
    }
    const s = status.toUpperCase();
    return s === 'DELIVERED' || s === 'RETURNED' || s === 'CANCELED' || s === 'COMPENSATED';
}

export function shouldIgnoreAsStale(
    incoming: string,
    current: string | null | undefined,
    incomingAt: Date | undefined,
    lastStatusAt: Date | null | undefined,
): boolean {
    if (lastStatusAt && incomingAt && incomingAt < lastStatusAt) {
        return true;
    }
    if (!current) {
        return false;
    }
    return statusRank(incoming) < statusRank(current);
}
