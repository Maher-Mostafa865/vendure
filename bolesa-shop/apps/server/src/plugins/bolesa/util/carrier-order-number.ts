import { createHash } from 'node:crypto';

/**
 * Order number sent on the airway bill.
 * Partner accepts 3–50 characters. Speedaf rejects a number longer than 32,
 * and the shop order code is 16 characters before any carrier reference is added.
 * The real shop code stays in meta.vendure_order_code.
 */
export const CARRIER_ORDER_NUMBER_LENGTH = 16;

export function carrierOrderNumber(orderCode: string, idempotencyKey: string): string {
    return createHash('sha256')
        .update(`${orderCode}:${idempotencyKey}`)
        .digest('hex')
        .slice(0, CARRIER_ORDER_NUMBER_LENGTH)
        .toUpperCase();
}
