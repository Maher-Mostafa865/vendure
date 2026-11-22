/**
 * Sanitized shipping diagnostics. Never include tokens, addresses, names, phones,
 * or city hashes. Price presence distinguishes null, undefined, zero, and a
 * positive number so a missing Partner price cannot be mistaken for free shipping.
 */

export type PricePresence = 'null' | 'undefined' | 'zero' | 'positive' | 'invalid';

export function pricePresence(value: unknown): PricePresence {
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'string' && value.trim() === '') {
        return 'invalid';
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) {
        return 'invalid';
    }
    if (n === 0) {
        return 'zero';
    }
    if (n > 0) {
        return 'positive';
    }
    return 'invalid';
}

/** Finite Partner prices, including a legitimate zero. Null and undefined are not prices. */
export function finitePrice(value: unknown): number | undefined {
    const presence = pricePresence(value);
    if (presence !== 'zero' && presence !== 'positive') {
        return undefined;
    }
    return typeof value === 'number' ? value : Number(value);
}

export function mappedPricePresence(value: number | undefined): PricePresence {
    return pricePresence(value);
}
