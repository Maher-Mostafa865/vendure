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
        const fields = getBolesaCustomFields();
        config.customFields.ProductVariant.push(...fields.ProductVariant);
        config.customFields.Address.push(...fields.Address);
        config.customFields.Order.push(...fields.Order);
        config.customFields.Fulfillment.push(...fields.Fulfillment);

        config.authOptions.customPermissions = [
            ...(config.authOptions.customPermissions ?? []),
            bolesaConnectionPermission,
            bolesaShipmentPermission,
        ];

        config.shippingOptions.shippingEligibilityCheckers.push(bolesaEligibilityChecker);
        config.shippingOptions.shippingCalculators.push(bolesaShippingCalculator);
        config.shippingOptions.fulfillmentHandlers.push(bolesaFulfillmentHandler);
        config.shippingOptions.process = [
            ...(config.shippingOptions.process ?? []),
            bolesaFulfillmentProcess,
        ];

        config.paymentOptions.paymentMethodHandlers.push(bolesaCodPaymentHandler);

        config.schedulerOptions = config.schedulerOptions ?? {};
        config.schedulerOptions.tasks = [...(config.schedulerOptions.tasks ?? []), bolesaReconcileTask];

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
            ...options,
        };
        return BolesaPlugin;
    }

    onApplicationBootstrap() {
        // Queues and event subscriptions are registered in BolesaShipmentService.onModuleInit
    }
}
