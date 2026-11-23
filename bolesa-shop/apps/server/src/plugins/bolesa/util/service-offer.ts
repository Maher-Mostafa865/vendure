import { majorToMinor } from './money';
import { PaymentPreference } from '../types';

/** Merchant settings for one Partner service. The shopper never sees the slug. */
export interface ServiceOfferConfig {
    slug: string;
    /** Lower numbers are used first when several services can deliver. */
    priority: number;
    /** Minor units added to the live carrier price. This is the store owner's profit. */
    profitMinor: number;
}

export interface PricedPartnerService {
    slug: string;
    ccPrice?: number;
    codPrice?: number;
    currencyCode?: string;
}

/** What the customer pays, plus the carrier amount kept for the admin AWB. */
export interface CustomerShippingQuote {
    slug: string;
    carrierPriceMinor: number;
    profitMinor: number;
    customerPriceMinor: number;
    currencyCode: string;
}

export function normalizeServiceOffers(raw: unknown): ServiceOfferConfig[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const bySlug = new Map<string, ServiceOfferConfig>();
    for (const row of raw) {
        if (!row || typeof row !== 'object') {
            continue;
        }
        const slug = String((row as { slug?: unknown }).slug ?? '').trim();
        if (!slug) {
            continue;
        }
        bySlug.set(slug, {
            slug,
            priority: finiteInt((row as { priority?: unknown }).priority, 100),
            profitMinor: finiteNonNegative((row as { profitMinor?: unknown }).profitMinor),
        });
    }
    return [...bySlug.values()];
}

/**
 * One customer price from the enabled services Partner can actually deliver.
 * Unavailable, unpriced, and wrong-currency services are skipped.
 * An empty enabled list offers nothing.
 */
export function quoteCustomerShipping(input: {
    services: PricedPartnerService[];
    enabledSlugs: string[];
    offers: ServiceOfferConfig[];
    preference: PaymentPreference;
    currencyCode: string;
    precision?: number;
}): CustomerShippingQuote | undefined {
    const enabled = new Set(input.enabledSlugs.map(slug => slug.trim()).filter(Boolean));
    if (enabled.size === 0) {
        return undefined;
    }
    const channel = input.currencyCode.trim().toUpperCase();
    if (!channel) {
        return undefined;
    }
    const precision = input.precision ?? 2;
    const offers = new Map(input.offers.map(offer => [offer.slug, offer]));
    const ranked: CustomerShippingQuote[] = [];
    for (const service of input.services) {
        if (!enabled.has(service.slug)) {
            continue;
        }
        const partner = service.currencyCode?.trim().toUpperCase();
        if (!partner || partner !== channel) {
            continue;
        }
        const major = input.preference === 'cod' ? service.codPrice : service.ccPrice;
        if (major == null || Number.isNaN(Number(major))) {
            continue;
        }
        const carrierPriceMinor = majorToMinor(major, precision);
        const offer = offers.get(service.slug);
        const profitMinor = offer?.profitMinor ?? 0;
        ranked.push({
            slug: service.slug,
            carrierPriceMinor,
            profitMinor,
            customerPriceMinor: carrierPriceMinor + profitMinor,
            currencyCode: partner,
        });
    }
    ranked.sort((a, b) => {
        const priorityA = offers.get(a.slug)?.priority ?? 100;
        const priorityB = offers.get(b.slug)?.priority ?? 100;
        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }
        return a.slug.localeCompare(b.slug);
    });
    return ranked[0];
}

/**
 * The three amounts stored on the order.
 * `priceMinor` is what the customer was charged. It is not recomputed when an
 * admin later picks a different carrier, and profit is not added again.
 */
export function chargedShippingQuote(input: {
    quoted: CustomerShippingQuote;
    chargedMinor?: number | null;
}): {
    serviceSlug: string;
    priceMinor: number;
    carrierPriceMinor: number;
    profitMinor: number;
    currencyCode: string;
} {
    const charged = typeof input.chargedMinor === 'number' && Number.isFinite(input.chargedMinor)
        ? Math.round(input.chargedMinor)
        : input.quoted.customerPriceMinor;
    return {
        serviceSlug: input.quoted.slug,
        priceMinor: charged,
        carrierPriceMinor: input.quoted.carrierPriceMinor,
        profitMinor: input.quoted.profitMinor,
        currencyCode: input.quoted.currencyCode,
    };
}

export interface CodPaymentDecision {
    ok: boolean;
    errorMessage?: string;
}

/** Backend cash-on-delivery gate. The shop UI is not the source of truth. */
export function evaluateCodPayment(input: {
    codEnabled: boolean;
    subTotalWithTax: number;
    /** Minor units, taken from the payment method eligibility checker. */
    minimumMinor: number;
    paymentPreference: string | null | undefined;
    quotedMinor: number | null;
    chargedMinor: number | null;
}): CodPaymentDecision {
    if (!input.codEnabled) {
        return { ok: false, errorMessage: 'Cash on delivery is not available.' };
    }
    if (
        !Number.isFinite(input.subTotalWithTax) ||
        !Number.isFinite(input.minimumMinor) ||
        input.subTotalWithTax < input.minimumMinor
    ) {
        return { ok: false, errorMessage: 'Cash on delivery is not available for this order.' };
    }
    if (input.paymentPreference !== 'cod') {
        return { ok: false, errorMessage: 'Choose cash on delivery before the shipping price is calculated.' };
    }
    if (
        input.quotedMinor == null ||
        input.chargedMinor == null ||
        input.quotedMinor !== input.chargedMinor
    ) {
        return { ok: false, errorMessage: 'The shipping price does not match cash on delivery. Choose shipping again.' };
    }
    return { ok: true };
}

/** Goods total is minor units. The minimum is the major amount entered in settings. */
export function codMeetsMinimum(
    subTotalWithTax: number,
    codMinimumMajor: number,
    precision = 2,
): boolean {
    if (!Number.isFinite(subTotalWithTax) || !Number.isFinite(codMinimumMajor) || codMinimumMajor < 0) {
        return false;
    }
    return subTotalWithTax >= majorToMinor(codMinimumMajor, precision);
}

function finiteInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.trunc(parsed);
}

function finiteNonNegative(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
    }
    return Math.round(parsed);
}
