import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { CollectionEvent, EventBus, Logger } from '@vendure/core';

import { collectionRevalidationTags } from './collection-revalidation-tags';
import { postStorefrontRevalidation } from './post-storefront-revalidation';

const loggerCtx = 'StorefrontRevalidationService';

@Injectable()
export class StorefrontRevalidationService implements OnApplicationBootstrap {
    private warnedMissingConfig = false;

    constructor(private eventBus: EventBus) {}

    onApplicationBootstrap(): void {
        this.eventBus.ofType(CollectionEvent).subscribe(event => {
            void this.revalidate(event).catch(err =>
                Logger.error(
                    `Collection ${event.type} cache revalidation failed: ${(err as Error).message}`,
                    loggerCtx,
                ),
            );
        });
    }

    private async revalidate(event: CollectionEvent): Promise<void> {
        const result = await postStorefrontRevalidation(collectionRevalidationTags(event.entity), {
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
    }
}
