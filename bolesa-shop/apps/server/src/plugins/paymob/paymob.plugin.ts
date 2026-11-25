import {
    PluginCommonModule,
    RuntimeVendureConfig,
    Type,
    VendurePlugin,
} from '@vendure/core';

import { adminApiExtensions } from './api/api-extensions';
import { PaymobAdminResolver } from './api/paymob-admin.resolver';
import { getPaymobCustomFields } from './config/custom-fields';
import { paymobEligibilityChecker } from './config/paymob-eligibility-checker';
import { paymobPaymentHandler } from './config/paymob-payment-handler';
import { PAYMOB_PLUGIN_OPTIONS } from './constants';
import { PaymobCallbackController } from './controllers/paymob-callback.controller';
import { PaymobConnection } from './entities/paymob-connection.entity';
import { paymobConnectionPermission } from './permissions';
import { PaymobClient } from './services/paymob-client.service';
import { PaymobConnectionService } from './services/paymob-connection.service';
import { PaymobSettlementService } from './services/paymob-settlement.service';
import { PaymobPluginOptions } from './types';

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [PaymobConnection],
    providers: [
        { provide: PAYMOB_PLUGIN_OPTIONS, useFactory: () => PaymobPlugin.options },
        PaymobClient,
        PaymobConnectionService,
        PaymobSettlementService,
    ],
    controllers: [PaymobCallbackController],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [PaymobAdminResolver],
    },
    compatibility: '^3.0.0',
    dashboard: './dashboard/index.tsx',
    configuration: (config: RuntimeVendureConfig) => {
        const fields = getPaymobCustomFields();
        const pushUnique = <T extends { name?: string; code?: string }>(
            target: T[],
            items: T[],
            key: 'name' | 'code',
        ) => {
            for (const item of items) {
                const k = item[key];
                if (k != null && target.some(t => t[key] === k)) {
                    continue;
                }
                target.push(item);
            }
        };

        config.customFields.Channel = config.customFields.Channel ?? [];
        pushUnique(config.customFields.Channel, fields.Channel, 'name');

        const permissionKey = (p: unknown): string =>
            ((p as { getMetadata?: () => Array<{ name: string }> }).getMetadata?.() ?? [])
                .map(m => m.name)
                .sort()
                .join(',');
        const perms = config.authOptions.customPermissions ?? [];
        for (const p of [paymobConnectionPermission]) {
            const key = permissionKey(p);
            if (!perms.some(x => x === p || permissionKey(x) === key)) {
                perms.push(p);
            }
        }
        config.authOptions.customPermissions = perms;

        pushUnique(
            config.paymentOptions.paymentMethodHandlers as any[],
            [paymobPaymentHandler] as any[],
            'code',
        );
        config.paymentOptions.paymentMethodEligibilityCheckers =
            config.paymentOptions.paymentMethodEligibilityCheckers ?? [];
        pushUnique(
            config.paymentOptions.paymentMethodEligibilityCheckers as any[],
            [paymobEligibilityChecker] as any[],
            'code',
        );

        return config;
    },
})
export class PaymobPlugin {
    static options: PaymobPluginOptions;

    static init(options: PaymobPluginOptions): Type<PaymobPlugin> {
        this.options = options;
        return PaymobPlugin;
    }
}
