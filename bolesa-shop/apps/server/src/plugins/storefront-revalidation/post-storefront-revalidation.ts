export type StorefrontRevalidationEnv = {
    url?: string;
    secret?: string;
};

export async function postStorefrontRevalidation(
    tags: string[],
    env: StorefrontRevalidationEnv,
    fetchImpl: typeof fetch = fetch,
): Promise<'ok' | 'skipped'> {
    if (!env.url || !env.secret || tags.length === 0) {
        return 'skipped';
    }

    const response = await fetchImpl(env.url, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${env.secret}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
        throw new Error(`Storefront revalidation failed with status ${response.status}`);
    }

    return 'ok';
}
