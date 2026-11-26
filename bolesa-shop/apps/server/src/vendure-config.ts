import {
    dummyPaymentHandler,
    DefaultEncryptionStrategy,
    DefaultJobQueuePlugin,
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    VendureConfig,
} from '@vendure/core';
import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import 'dotenv/config';
import path from 'path';
import { standardCodPaymentHandler } from './config/standard-cod-payment-handler';
import { BolesaPlugin } from './plugins/bolesa';
import { NestLensDevPlugin } from './plugins/nestlens/nestlens.plugin';
import { PaymobPlugin } from './plugins/paymob';
import { StorefrontRevalidationPlugin } from './plugins/storefront-revalidation/storefront-revalidation.plugin';

const IS_DEV = process.env.APP_ENV === 'dev';
// nestlens@0.14 peers Nest <=11; workspace postinstall links apps/server @nestjs → Nest 12
// so HttpAdapterHost DI works. Set NESTLENS_ENABLED=1 in .env to mount /nestlens.
const NESTLENS_ENABLED = process.env.NESTLENS_ENABLED === '1';
// PORT wins because hosting platforms inject it into the environment at runtime, and that
// must take precedence over any value baked into the .env file at scaffold time.
const serverPort = +process.env.PORT || +process.env.VENDURE_SERVER_PORT || 3000;
const encryptionSecret =
    process.env.VENDURE_ENCRYPTION_KEY || process.env.COOKIE_SECRET || 'dev-only-change-me';
const serverBaseUrl = (process.env.APP_URL || `http://localhost:${serverPort}`).replace(/\/$/, '');
const storefrontBaseUrl = (process.env.STOREFRONT_URL || 'http://localhost:3001').replace(/\/$/, '');

export const config: VendureConfig = {
    apiOptions: {
        port: serverPort,
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        trustProxy: IS_DEV ? false : 1,
        // Which browser origins may make credentialed requests to the Shop and Admin APIs.
        // In dev any origin is reflected, so a storefront on any port works. In production set
        // CORS_ORIGINS to a comma-separated list of the origins you serve, for example
        // "https://example.com,https://admin.example.com". An unset value blocks all
        // cross-origin browser requests, which is the safe default.
        cors: {
            origin: IS_DEV ? true : (process.env.CORS_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) ?? []),
            credentials: true,
        },
    },
    authOptions: {
        tokenMethod: ['bearer', 'cookie'],
        superadminCredentials: {
            identifier: process.env.SUPERADMIN_USERNAME,
            password: process.env.SUPERADMIN_PASSWORD,
        },
        cookieOptions: {
          secret: process.env.COOKIE_SECRET,
        },
    },
    dbConnectionOptions: {
        type: 'postgres',
        // See the README.md "Migrations" section for an explanation of
        // the `synchronize` and `migrations` options.
        synchronize: false,
        migrations: [path.join(__dirname, './migrations/*.+(js|ts)')],
        logging: false,
        database: process.env.DB_NAME,
        schema: process.env.DB_SCHEMA,
        host: process.env.DB_HOST,
        port: +process.env.DB_PORT,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler, standardCodPaymentHandler],
    },
    systemOptions: {
        encryptionStrategy: new DefaultEncryptionStrategy({
            secret: encryptionSecret,
        }),
    },
    // When adding or altering custom field definitions, the database will
    // need to be updated. See the "Migrations" section in README.md.
    customFields: {},
    plugins: [
        BolesaPlugin.init({
            apiBaseUrl: process.env.BOLESA_API_BASE_URL || 'https://api.bolesa.example/api/pcl/v1',
            encryptionSecret,
            rateCacheTtlMs: 600_000,
            defaultCountryCode: 'EG',
        }),
        PaymobPlugin.init({
            serverBaseUrl,
            storefrontBaseUrl,
            encryptionSecret,
        }),
        GraphiqlPlugin.init(),
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: path.join(__dirname, '../static/assets'),
            // For local dev, the correct value for assetUrlPrefix should
            // be guessed correctly, but for production it will usually need
            // to be set manually to match your production url.
            assetUrlPrefix: IS_DEV ? undefined : 'https://www.my-shop.com/assets/',
        }),
        DefaultSchedulerPlugin.init(),
        DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
        EmailPlugin.init({
            // In dev mode, emails are written to disk instead of being sent, and the dev mailbox
            // at /mailbox lists and serves all of them without authentication.
            ...(IS_DEV ? {
                devMode: true,
                outputPath: path.join(__dirname, '../static/email/test-emails'),
                route: 'mailbox',
            } : {
                // No email transport is configured yet, so emails are written to this directory
                // and not sent. Replace this with an SMTP, SES or other transport before you go
                // live: https://docs.vendure.io/reference/core-plugins/email-plugin/
                // This is the same directory that dev mode uses. Nothing serves it over HTTP.
                transport: {
                    type: 'file',
                    outputPath: path.join(__dirname, '../static/email/test-emails'),
                },
            }),
            handlers: defaultEmailHandlers,
            templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../static/email/templates')),
            globalTemplateVars: {
                // The following variables will change depending on your storefront implementation.
                // These point at the storefront created alongside this server, on the port it
                // was assigned. Change them if you move the storefront elsewhere.
                fromAddress: '"example" <noreply@example.com>',
                verifyEmailAddressUrl: 'http://localhost:3001/verify',
                passwordResetUrl: 'http://localhost:3001/reset-password',
                changeEmailAddressUrl: 'http://localhost:3001/account/verify-email',
                // The URL of the password reset page of the Vendure Dashboard.
                adminPasswordResetUrl: `http://localhost:${serverPort}/dashboard/reset-password`
            },
        }),
        StorefrontRevalidationPlugin,
        ...(IS_DEV && NESTLENS_ENABLED ? [NestLensDevPlugin] : []),
        DashboardPlugin.init({
            route: 'dashboard',
            appDir: IS_DEV
                ? path.join(__dirname, '../dist/dashboard')
                : path.join(__dirname, 'dashboard'),
        }),
    ],
};
