import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ID } from '@vendure/common/lib/shared-types';
import {
    CollectionEvent,
    EventBus,
    Logger,
    ProductEvent,
    ProductVariantEvent,
    TransactionalConnection,
} from '@vendure/core';

import { catalogRevalidationTags } from './catalog-revalidation-tags';
import { collectionRevalidationTags } from './collection-revalidation-tags';
import { postStorefrontRevalidation } from './post-storefront-revalidation';
import { waitForSearchIndexToSettle } from './wait-for-search-index';

const loggerCtx = 'StorefrontRevalidationService';

@Injectable()
export class StorefrontRevalidationService implements OnApplicationBootstrap {
    private warnedMissingConfig = false;

    constructor(
        private eventBus: EventBus,
        private connection: TransactionalConnection,
    ) {}

    onApplicationBootstrap(): void {
        this.eventBus.ofType(CollectionEvent).subscribe(event => {
            void this.revalidate(collectionRevalidationTags(event.entity), `Collection ${event.type}`).catch(err =>
                Logger.error(
                    `Collection ${event.type} cache revalidation failed: ${(err as Error).message}`,
                    loggerCtx,
                ),
            );
        });

        this.eventBus.ofType(ProductEvent).subscribe(event => {
            void this.revalidateProducts([event.entity.id], `Product ${event.type}`).catch(err =>
                Logger.error(
                    `Product ${event.type} cache revalidation failed: ${(err as Error).message}`,
                    loggerCtx,
                ),
            );
        });

        this.eventBus.ofType(ProductVariantEvent).subscribe(event => {
            const productIds = event.entity.map(variant => variant.productId);
            void this.revalidateProducts(productIds, `Product variant ${event.type}`).catch(err =>
                Logger.error(
                    `Product variant ${event.type} cache revalidation failed: ${(err as Error).message}`,
                    loggerCtx,
                ),
            );
        });
    }

    private async revalidateProducts(productIds: ID[], reason: string): Promise<void> {
        // The shop reads the search index, which is updated by a background job after this event.
        // Wait until that job settles so the page does not cache the old empty result again.
        await waitForSearchIndexToSettle(() => this.countActiveSearchIndexJobs());
        const tags = catalogRevalidationTags(await this.slugsForProducts(productIds));
        await this.revalidate(tags, reason);
    }

    private async countActiveSearchIndexJobs(): Promise<number> {
        const rows: Array<{ count: string | number }> = await this.connection.rawConnection.query(
            `SELECT COUNT(*)::int AS count
             FROM job_record
             WHERE "queueName" = 'update-search-index'
               AND state IN ('PENDING', 'RUNNING', 'RETRYING')`,
        );
        return Number(rows[0]?.count ?? 0);
    }

    private async slugsForProducts(productIds: ID[]): Promise<{
        collectionSlugs: string[];
        productSlugs: string[];
    }> {
        const ids = [...new Set(productIds.map(id => Number(id)).filter(id => Number.isInteger(id)))];
        if (ids.length === 0) {
            return { collectionSlugs: [], productSlugs: [] };
        }

        const [collections, products]: [Array<{ slug: string }>, Array<{ slug: string }>] = await Promise.all([
            this.connection.rawConnection.query(
                `SELECT DISTINCT ct.slug AS slug
                 FROM product_variant pv
                 INNER JOIN collection_product_variants_product_variant j
                    ON j."productVariantId" = pv.id
                 INNER JOIN collection_translation ct ON ct."baseId" = j."collectionId"
                 WHERE pv."productId" = ANY($1::int[])
                   AND ct.slug IS NOT NULL
                   AND btrim(ct.slug) <> ''`,
                [ids],
            ),
            this.connection.rawConnection.query(
                `SELECT DISTINCT slug
                 FROM product_translation
                 WHERE "baseId" = ANY($1::int[])
                   AND slug IS NOT NULL
                   AND btrim(slug) <> ''`,
                [ids],
            ),
        ]);

        return {
            collectionSlugs: collections.map(row => row.slug),
            productSlugs: products.map(row => row.slug),
        };
    }

    private async revalidate(tags: string[], reason: string): Promise<void> {
        const result = await postStorefrontRevalidation(tags, {
            url: process.env.STOREFRONT_REVALIDATE_URL,
            secret: process.env.STOREFRONT_REVALIDATION_SECRET,
        });
        if (result === 'skipped' && !this.warnedMissingConfig) {
            this.warnedMissingConfig = true;
            Logger.warn(
                'STOREFRONT_REVALIDATE_URL or STOREFRONT_REVALIDATION_SECRET is not set, so collection changes will stay cached on the storefront',
                loggerCtx,
            );
        }
        if (result === 'ok') {
            Logger.verbose(`${reason} refreshed ${tags.length} storefront cache tags`, loggerCtx);
        }
    }
}
