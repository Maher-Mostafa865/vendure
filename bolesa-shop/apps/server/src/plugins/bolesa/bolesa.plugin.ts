import { OnApplicationBootstrap } from '@nestjs/common';
import {
    PluginCommonModule,
    RuntimeVendureConfig,
    Type,
    VendurePlugin,
} from '@vendure/core';

import './types-augmentation';
import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { BolesaAdminResolver } from './api/bolesa-admin.resolver';
import { BolesaShopResolver } from './api/bolesa-shop.resolver';
import { bolesaCodEligibilityChecker } from './config/bolesa-cod-eligibility-checker';
import { bolesaCodPaymentHandler } from './config/bolesa-cod-payment-handler';
import { bolesaEligibilityChecker } from './config/bolesa-eligibility-checker';
import { bolesaFulfillmentHandler } from './config/bolesa-fulfillment-handler';
import { bolesaFulfillmentProcess } from './config/bolesa-fulfillment-process';
import { bolesaShippingCalculator } from './config/bolesa-shipping-calculator';
import { getBolesaCustomFields } from './config/custom-fields';
import { BOLESA_PLUGIN_OPTIONS } from './constants';
import { BolesaConnection } from './entities/bolesa-connection.entity';
import { BolesaShipment } from './entities/bolesa-shipment.entity';
import { bolesaConnectionPermission, bolesaShipmentPermission } from './permissions';
import { BolesaClient } from './services/bolesa-client.service';
import { BolesaConnectionService } from './services/bolesa-connection.service';
import { BolesaRateService } from './services/bolesa-rate.service';
import { bolesaReconcileTask } from './services/bolesa-reconcile.task';
import { BolesaShipmentService } from './services/bolesa-shipment.service';
import { BolesaPluginOptions } from './types';

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [BolesaConnection, BolesaShipment],
    providers: [
        { provide: BOLESA_PLUGIN_OPTIONS, useFactory: () => BolesaPlugin.options },
        BolesaClient,
        BolesaConnectionService,
        BolesaRateService,
        BolesaShipmentService,
    ],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [BolesaAdminResolver],
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [BolesaShopResolver],
    },
    compatibility: '^3.0.0',
    dashboard: './dashboard/index.tsx',
    configuration: (config: RuntimeVendureConfig) => {
        // Idempotent: server + worker bootstrap in one process must not duplicate fields/handlers.
        const fields = getBolesaCustomFields();
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
        pushUnique(config.customFields.ProductVariant, fields.ProductVariant, 'name');
        pushUnique(config.customFields.Address, fields.Address, 'name');
        pushUnique(config.customFields.Order, fields.Order, 'name');
        pushUnique(config.customFields.Fulfillment, fields.Fulfillment, 'name');

        // RwPermissionDefinition does not expose `.name` on the instance. Comparing
        // `(x as any).name` treated the 2nd definition as a duplicate (undefined ===
        // undefined) and skipped BolesaShipment from the GraphQL Permission enum.
        const permissionKey = (p: unknown): string =>
            ((p as { getMetadata?: () => Array<{ name: string }> }).getMetadata?.() ?? [])
                .map(m => m.name)
                .sort()
                .join(',');
        const perms = config.authOptions.customPermissions ?? [];
        for (const p of [bolesaConnectionPermission, bolesaShipmentPermission]) {
            const key = permissionKey(p);
            if (!perms.some(x => x === p || permissionKey(x) === key)) {
                perms.push(p);
            }
        }
        config.authOptions.customPermissions = perms;

        pushUnique(
            config.shippingOptions.shippingEligibilityCheckers as any[],
            [bolesaEligibilityChecker] as any[],
            'code',
        );
        pushUnique(
            config.shippingOptions.shippingCalculators as any[],
            [bolesaShippingCalculator] as any[],
            'code',
        );
        pushUnique(
            config.shippingOptions.fulfillmentHandlers as any[],
            [bolesaFulfillmentHandler] as any[],
            'code',
        );
        const processes = config.shippingOptions.process ?? [];
        if (!processes.includes(bolesaFulfillmentProcess)) {
            config.shippingOptions.process = [...processes, bolesaFulfillmentProcess];
        }

        pushUnique(
            config.paymentOptions.paymentMethodHandlers as any[],
            [bolesaCodPaymentHandler] as any[],
            'code',
        );
        config.paymentOptions.paymentMethodEligibilityCheckers =
            config.paymentOptions.paymentMethodEligibilityCheckers ?? [];
        pushUnique(
            config.paymentOptions.paymentMethodEligibilityCheckers as any[],
            [bolesaCodEligibilityChecker] as any[],
            'code',
        );

        config.schedulerOptions = config.schedulerOptions ?? {};
        const tasks = config.schedulerOptions.tasks ?? [];
        if (!tasks.some(t => t.id === bolesaReconcileTask.id)) {
            config.schedulerOptions.tasks = [...tasks, bolesaReconcileTask];
        }

        return config;
    },
})
export class BolesaPlugin implements OnApplicationBootstrap {
    static options: BolesaPluginOptions;

    static init(options: BolesaPluginOptions): Type<BolesaPlugin> {
        this.options = {
            rateCacheTtlMs: 600_000,
            defaultCountryCode: 'EG',
            reconcileSchedule: '*/15 * * * *',
            reconcileBatchSize: 100,
            reconcileMaxBatches: 10,
            citySearchRateLimit: { maxRequests: 30, windowMs: 60_000 },
            stuckShipmentThresholdMs: 30 * 60_000,
            ...options,
        };
        return BolesaPlugin;
    }

    onApplicationBootstrap() {
        // Queues and event subscriptions are registered in BolesaShipmentService.onModuleInit
    }
}
