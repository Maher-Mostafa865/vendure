import { majorToMinor } from './money';

/** Last Partner catalogue row. Names only; checkout prices come from services/options. */
export interface SavedAccountService {
    slug: string;
    name: string;
}

/**
 * Last finite price returned by POST /services/options for one service.
 * A missing side means that payment type has not returned a price yet.
 * Checkout does not charge these amounts.
 */
export interface SavedServiceRate {
    slug: string;
    currencyCode: string;
    ccPriceMinor: number | null;
    codPriceMinor: number | null;
    quotedAt: string;
}

export function normalizeAccountServices(raw: unknown): SavedAccountService[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const bySlug = new Map<string, SavedAccountService>();
    for (const row of raw) {
        if (!row || typeof row !== 'object') {
            continue;
        }
        const slug = String((row as { slug?: unknown }).slug ?? '').trim();
        const name = String((row as { name?: unknown }).name ?? '').trim();
        if (!slug) {
            continue;
        }
        bySlug.set(slug, { slug, name: name || slug });
    }
    return [...bySlug.values()];
}

export function sameAccountServices(left: unknown, right: SavedAccountService[]): boolean {
    const current = normalizeAccountServices(left);
    if (current.length !== right.length) {
        return false;
    }
    return current.every((row, index) => row.slug === right[index]?.slug && row.name === right[index]?.name);
}

export function normalizeServiceRates(raw: unknown): SavedServiceRate[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const bySlug = new Map<string, SavedServiceRate>();
    for (const row of raw) {
        if (!row || typeof row !== 'object') {
            continue;
        }
        const slug = String((row as { slug?: unknown }).slug ?? '').trim();
        const currencyCode = String((row as { currencyCode?: unknown }).currencyCode ?? '').trim().toUpperCase();
        if (!slug || !currencyCode) {
            continue;
        }
        bySlug.set(slug, {
            slug,
            currencyCode,
            ccPriceMinor: finiteMinor((row as { ccPriceMinor?: unknown }).ccPriceMinor),
            codPriceMinor: finiteMinor((row as { codPriceMinor?: unknown }).codPriceMinor),
            quotedAt: String((row as { quotedAt?: unknown }).quotedAt ?? ''),
        });
    }
    return [...bySlug.values()];
}

/**
 * Keep the last finite card and cash prices. A response that prices only one
 * side does not erase the other side. A currency change drops both old prices.
 */
export function mergeServiceRates(
    current: unknown,
    incoming: Array<{ slug?: string; ccPrice?: number | null; codPrice?: number | null; currencyCode?: string }>,
    quotedAt: string,
    precision = 2,
): SavedServiceRate[] {
    const bySlug = new Map(normalizeServiceRates(current).map(row => [row.slug, { ...row }]));
    for (const row of incoming) {
        const slug = String(row.slug ?? '').trim();
        const currencyCode = String(row.currencyCode ?? '').trim().toUpperCase();
        if (!slug || !currencyCode) {
            continue;
        }
        const cc = finiteMajor(row.ccPrice);
        const cod = finiteMajor(row.codPrice);
        if (cc == null && cod == null) {
            continue;
        }
        const previous = bySlug.get(slug);
        const next: SavedServiceRate = previous && previous.currencyCode === currencyCode
            ? { ...previous }
            : { slug, currencyCode, ccPriceMinor: null, codPriceMinor: null, quotedAt };
        if (cc != null) {
            next.ccPriceMinor = majorToMinor(cc, precision);
        }
        if (cod != null) {
            next.codPriceMinor = majorToMinor(cod, precision);
        }
        next.quotedAt = quotedAt;
        bySlug.set(slug, next);
    }
    return [...bySlug.values()];
}

export function sameServiceRates(left: unknown, right: SavedServiceRate[]): boolean {
    const current = normalizeServiceRates(left);
    if (current.length !== right.length) {
        return false;
    }
    return current.every((row, index) => {
        const other = right[index];
        return !!other
            && row.slug === other.slug
            && row.currencyCode === other.currencyCode
            && row.ccPriceMinor === other.ccPriceMinor
            && row.codPriceMinor === other.codPriceMinor;
    });
}

function finiteMinor(value: unknown): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }
    return Math.round(parsed);
}

function finiteMajor(value: unknown): number | null {
    if (value == null) {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }
    return parsed;
}
