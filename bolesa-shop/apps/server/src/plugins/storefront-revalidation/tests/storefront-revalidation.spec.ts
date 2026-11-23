import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { catalogRevalidationTags } from '../catalog-revalidation-tags';
import { collectionRevalidationTags } from '../collection-revalidation-tags';
import { postStorefrontRevalidation } from '../post-storefront-revalidation';
import { waitForSearchIndexToSettle } from '../wait-for-search-index';

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

    it('refreshes the collection page and the product page after a product change', () => {
        assert.deepEqual(
            catalogRevalidationTags({
                collectionSlugs: ['collection-test-navbar', 'collection-test-navbar', ' '],
                productSlugs: ['test-electronics-and-blue', null],
            }),
            [
                'featured',
                'collection-collection-test-navbar',
                'collection-meta-collection-test-navbar',
                'related-products-collection-test-navbar',
                'product-test-electronics-and-blue',
            ],
        );
    });

    it('waits until the search index job is idle before refreshing', async () => {
        const states = [1, 1, 0, 0];
        let polls = 0;
        let slept = 0;
        await waitForSearchIndexToSettle(
            async () => states[polls++] ?? 0,
            {
                timeoutMs: 1000,
                intervalMs: 10,
                idlePolls: 2,
                sleep: async () => {
                    slept += 1;
                },
                now: () => 0,
            },
        );
        assert.equal(polls, 4);
        assert.equal(slept, 4);
    });

    it('stops waiting when the search index job does not settle in time', async () => {
        let clock = 0;
        let polls = 0;
        await waitForSearchIndexToSettle(async () => {
            polls += 1;
            return 1;
        }, {
            timeoutMs: 30,
            intervalMs: 10,
            sleep: async () => {
                clock += 10;
            },
            now: () => clock,
        });
        assert.equal(polls, 3);
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
