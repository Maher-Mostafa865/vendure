/** Normalize a stored or submitted list of Partner service slugs. */
export function merchantServiceSlugs(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return [...new Set(raw.map(value => (typeof value === 'string' ? value.trim() : '')).filter(Boolean))];
}

export interface AwbServiceChoice {
    customerSlug?: string | null;
    quoteSlug?: string | null;
    defaultSlug?: string | null;
    enabledSlugs: string[];
}

/**
 * The customer's saved slug wins. A slug outside the merchant's enabled list is an error,
 * not a reason to switch carriers. The default is used only when the customer did not choose.
 */
export function resolveAwbServiceSlug(input: AwbServiceChoice): { slug: string } | { error: string } {
    const enabled = merchantServiceSlugs(input.enabledSlugs);
    const customer = input.customerSlug?.trim();
    if (customer && customer !== 'auto' && customer !== 'default') {
        if (enabled.length && !enabled.includes(customer)) {
            return {
                error: `Selected service ${customer} is not enabled for this channel.`,
            };
        }
        return { slug: customer };
    }
    // Default before a stored quote. The quote can be the first priced service from
    // an `auto` shipping method, and that must not replace the merchant's default.
    const fallback = [input.defaultSlug, input.quoteSlug]
        .map(value => value?.trim())
        .find(value => value && value !== 'auto' && value !== 'default' && (!enabled.length || enabled.includes(value)));
    if (!fallback) {
        return {
            error: 'No Bolesa service is selected. Choose a carrier at checkout or set a default service that is enabled for this channel.',
        };
    }
    return { slug: fallback };
}

/**
 * Bosta rejects allow_open unless public product photo URLs are sent.
 * Partner config: slug prefix `bosta_` → allow_open_images_required.
 */
export function openShipmentImageError(allowOpen: boolean, serviceSlug: string): string | undefined {
    if (!allowOpen || !serviceSlug.startsWith('bosta_')) {
        return undefined;
    }
    return (
        'Bosta needs at least one public product photo (http or https) before the customer can open the shipment. ' +
        'The AWB was not sent (allow_open_images_required).'
    );
}
