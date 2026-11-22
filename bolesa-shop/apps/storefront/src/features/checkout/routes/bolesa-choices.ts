export interface BolesaChoice {
    slug: string;
    name: string;
    label?: string;
    logoUrl?: string;
    priceMinor: number;
}

export function bolesaChoicesFromMetadata(metadata: Record<string, unknown> | null | undefined): BolesaChoice[] {
    const raw = metadata?.options;
    if (!Array.isArray(raw)) {
        return [];
    }
    const choices: BolesaChoice[] = [];
    for (const row of raw) {
        if (!row || typeof row !== 'object') {
            continue;
        }
        const option = row as Record<string, unknown>;
        if (typeof option.slug !== 'string' || option.slug.length === 0) {
            continue;
        }
        if (typeof option.priceMinor !== 'number' || !Number.isFinite(option.priceMinor)) {
            continue;
        }
        choices.push({
            slug: option.slug,
            name: typeof option.name === 'string' && option.name ? option.name : option.slug,
            label: typeof option.label === 'string' ? option.label : undefined,
            logoUrl: typeof option.logoUrl === 'string' ? option.logoUrl : undefined,
            priceMinor: option.priceMinor,
        });
    }
    return choices;
}

export function selectedBolesaSlug(metadata: Record<string, unknown> | null | undefined): string | null {
    const slug = metadata?.serviceSlug;
    return typeof slug === 'string' && slug.length > 0 ? slug : null;
}
