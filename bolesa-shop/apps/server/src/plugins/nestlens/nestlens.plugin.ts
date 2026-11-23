import { VendurePlugin } from '@vendure/core';
import { NestLensModule } from 'nestlens';

/**
 * Dev-only request inspector. Registered from vendure-config only when APP_ENV=dev.
 * The dashboard is http://localhost:<VENDURE_SERVER_PORT>/nestlens.
 */
@VendurePlugin({
    imports: [
        NestLensModule.forRoot({
            enabled: true,
            path: '/nestlens',
            authorization: {
                environmentVariable: 'APP_ENV',
                allowedEnvironments: ['dev'],
            },
        }),
    ],
    compatibility: '^3.0.0',
})
export class NestLensDevPlugin {}
