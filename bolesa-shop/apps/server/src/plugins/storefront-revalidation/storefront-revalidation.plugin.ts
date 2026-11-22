import { PluginCommonModule, VendurePlugin } from '@vendure/core';

import { StorefrontRevalidationService } from './storefront-revalidation.service';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [StorefrontRevalidationService],
    compatibility: '^3.0.0',
})
export class StorefrontRevalidationPlugin {}
