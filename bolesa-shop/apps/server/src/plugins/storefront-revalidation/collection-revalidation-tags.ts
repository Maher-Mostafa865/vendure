export function collectionRevalidationTags(collection: {
    translations?: Array<{ slug?: string | null }>;
}): string[] {
    const tags = ['navbar-collections', 'collections', 'footer', 'mobile-nav'];
    const slugs = new Set<string>();
    for (const translation of collection.translations ?? []) {
        const slug = translation.slug?.trim();
        if (slug) {
            slugs.add(slug);
        }
    }
    for (const slug of slugs) {
        tags.push(`collection-${slug}`, `collection-meta-${slug}`);
    }
    return tags;
}
