import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectionRevalidationTags } from '../collection-revalidation-tags';
import { postStorefrontRevalidation } from '../post-storefront-revalidation';

describe('collection storefront revalidation', () => {
    it('refreshes the navbar, footer, and the collection page for each slug', () => {
        const tags = collectionRevalidationTags({
            translations: [
                { slug: 'collection' },
                { slug: 'collection' },
                { slug: '  ' },
                { slug: null },
            ],
        });

        assert.deepEqual(tags, [
            'navbar-collections',
            'collections',
            'footer',
            'mobile-nav',
            'collection-collection',
            'collection-meta-collection',
        ]);
    });

    it('still refreshes the navbar when the deleted collection has no slug', () => {
        assert.deepEqual(collectionRevalidationTags({}), [
            'navbar-collections',
            'collections',
            'footer',
            'mobile-nav',
        ]);
    });

    it('posts the tags with the bearer secret', async () => {
        let captured: { url: string; init: RequestInit } | undefined;
        const fetchImpl: typeof fetch = async (url, init) => {
            captured = { url: String(url), init: init ?? {} };
            return new Response(JSON.stringify({ revalidated: true }), { status: 200 });
        };

        const result = await postStorefrontRevalidation(
            ['navbar-collections'],
            { url: 'http://localhost:3001/api/revalidate', secret: 'test-secret' },
            fetchImpl,
        );

        assert.equal(result, 'ok');
        assert.equal(captured?.url, 'http://localhost:3001/api/revalidate');
        assert.equal((captured?.init.headers as Record<string, string>).authorization, 'Bearer test-secret');
        assert.equal(captured?.init.body, JSON.stringify({ tags: ['navbar-collections'] }));
    });

    it('skips the request when the storefront url is not configured', async () => {
        let called = false;
        const fetchImpl: typeof fetch = async () => {
            called = true;
            return new Response(null, { status: 200 });
        };

        const result = await postStorefrontRevalidation(['navbar-collections'], {}, fetchImpl);

        assert.equal(result, 'skipped');
        assert.equal(called, false);
    });

    it('throws when the storefront rejects the request', async () => {
        const fetchImpl: typeof fetch = async () => new Response('no', { status: 401 });

        await assert.rejects(
            () =>
                postStorefrontRevalidation(
                    ['navbar-collections'],
                    { url: 'http://localhost:3001/api/revalidate', secret: 'wrong' },
                    fetchImpl,
                ),
            /status 401/,
        );
    });
});
