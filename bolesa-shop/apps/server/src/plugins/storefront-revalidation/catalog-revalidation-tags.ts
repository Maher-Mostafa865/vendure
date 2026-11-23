function uniqueSlugs(slugs: Array<string | null | undefined> | undefined): string[] {
    const unique = new Set<string>();
    for (const slug of slugs ?? []) {
        const trimmed = slug?.trim();
        if (trimmed) {
            unique.add(trimmed);
        }
    }
    return [...unique];
}

export function catalogRevalidationTags(input: {
    collectionSlugs?: Array<string | null | undefined>;
    productSlugs?: Array<string | null | undefined>;
}): string[] {
    const tags = ['featured'];
    for (const slug of uniqueSlugs(input.collectionSlugs)) {
        tags.push(`collection-${slug}`, `collection-meta-${slug}`, `related-products-${slug}`);
    }
    for (const slug of uniqueSlugs(input.productSlugs)) {
        tags.push(`product-${slug}`);
    }
    return tags;
}
