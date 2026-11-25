import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paymob transaction callback HMAC field order (Accept docs).
 * Concatenate values in this order, then HMAC-SHA512 with the HMAC secret.
 */
export const PAYMOB_HMAC_FIELDS = [
    'amount_cents',
    'created_at',
    'currency',
    'error_occured',
    'has_parent_transaction',
    'id',
    'integration_id',
    'is_3d_secure',
    'is_auth',
    'is_capture',
    'is_refunded',
    'is_standalone_payment',
    'is_voided',
    'order',
    'owner',
    'pending',
    'source_data.pan',
    'source_data.sub_type',
    'source_data.type',
    'success',
] as const;

function readPath(obj: Record<string, unknown>, path: string): unknown {
    // Paymob GET redirects often use flat keys like "source_data.pan".
    if (Object.prototype.hasOwnProperty.call(obj, path)) {
        const direct = obj[path];
        if (path === 'order' && direct != null && typeof direct === 'object' && 'id' in (direct as object)) {
            return (direct as { id: unknown }).id;
        }
        return direct;
    }
    if (path === 'order') {
        const order = obj.order;
        if (order != null && typeof order === 'object' && 'id' in (order as object)) {
            return (order as { id: unknown }).id;
        }
        return order;
    }
    if (path.includes('.')) {
        const [head, ...rest] = path.split('.');
        const next = obj[head];
        if (next == null || typeof next !== 'object') {
            return undefined;
        }
        return readPath(next as Record<string, unknown>, rest.join('.'));
    }
    return obj[path];
}

export function buildPaymobHmacMessage(payload: Record<string, unknown>): string {
    return PAYMOB_HMAC_FIELDS.map(field => {
        const value = readPath(payload, field);
        if (value === true || value === false) {
            return value ? 'true' : 'false';
        }
        if (value == null) {
            return '';
        }
        return String(value);
    }).join('');
}

export function verifyPaymobHmac(
    payload: Record<string, unknown>,
    hmac: string | null | undefined,
    hmacSecret: string,
): boolean {
    if (!hmac || !hmacSecret) {
        return false;
    }
    const message = buildPaymobHmacMessage(payload);
    const calculated = createHmac('sha512', hmacSecret).update(message).digest('hex');
    const a = Buffer.from(calculated, 'utf8');
    const b = Buffer.from(String(hmac), 'utf8');
    if (a.length !== b.length) {
        return false;
    }
    return timingSafeEqual(a, b);
}

/** Paymob may nest the transaction under `obj` on POST callbacks. */
export function extractPaymobTransactionPayload(
    body: Record<string, unknown> | null | undefined,
    query: Record<string, unknown> | null | undefined,
): { payload: Record<string, unknown>; hmac: string | null } {
    const source = body && Object.keys(body).length ? body : query ?? {};
    const hmac =
        (typeof source.hmac === 'string' && source.hmac) ||
        (typeof query?.hmac === 'string' && query.hmac) ||
        null;

    if (source.obj && typeof source.obj === 'object') {
        return { payload: source.obj as Record<string, unknown>, hmac };
    }
    return { payload: source as Record<string, unknown>, hmac };
}

export function isPaymobSuccess(payload: Record<string, unknown>): boolean {
    return payload.success === true || payload.success === 'true';
}
