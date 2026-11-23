import { Inject, Injectable } from '@nestjs/common';
import {
    ChannelService,
    ConfigService,
    Logger,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';

import { BOLESA_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { BolesaConnection } from '../entities/bolesa-connection.entity';
import { BolesaPluginOptions, BolesaServiceOption } from '../types';
import { merchantServiceSlugs } from '../util/merchant-services';
import { normalizeServiceOffers, ServiceOfferConfig } from '../util/service-offer';
import {
    mergeServiceRates,
    normalizeAccountServices,
    normalizeServiceRates,
    sameAccountServices,
    sameServiceRates,
} from '../util/service-rates';
import { BolesaApiError, BolesaClient } from './bolesa-client.service';

export interface UpdateBolesaConnectionInput {
    apiBaseUrl?: string;
    token?: string;
    shipperAddress?: Record<string, unknown> | null;
    defaultServiceSlug?: string | null;
    enabledServiceSlugs?: string[] | null;
    serviceOffers?: ServiceOfferConfig[] | null;
    codMinimumMajor?: number;
    allowOpen?: boolean;
    autoCreateAwb?: boolean;
    shipmentCategory?: 'dry' | 'heavy' | 'cold';
    creationMode?: 'manual' | 'onPaymentSettled' | 'onPlaced';
    codEnabled?: boolean;
    codFeeMode?: 'absorb' | 'passToCustomer';
    markupPercent?: number;
    isActive?: boolean;
}

@Injectable()
export class BolesaConnectionService {
    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private client: BolesaClient,
        private configService: ConfigService,
        @Inject(BOLESA_PLUGIN_OPTIONS) private options: BolesaPluginOptions,
    ) {}

    async getForChannel(ctx: RequestContext): Promise<BolesaConnection | null> {
        return this.connection.rawConnection.getRepository(BolesaConnection)
            .createQueryBuilder('c')
            .innerJoin('c.channels', 'ch', 'ch.id = :channelId', { channelId: ctx.channelId })
            .orderBy('c.id', 'ASC')
            .getOne();
    }

    async requireActive(ctx: RequestContext): Promise<BolesaConnection> {
        const conn = await this.getForChannel(ctx);
        if (!conn || !conn.isActive) {
            throw new UserInputError('Bolesa connection is not configured or inactive for this channel');
        }
        return conn;
    }

    decryptToken(conn: BolesaConnection): string {
        const strategy = this.configService.systemOptions.encryptionStrategy;
        if (!strategy?.isConfigured()) {
            throw new Error('EncryptionStrategy is not configured; cannot decrypt Bolesa token');
        }
        return strategy.decrypt(conn.tokenEncrypted);
    }

    authFor(conn: BolesaConnection) {
        return {
            apiBaseUrl: conn.apiBaseUrl,
            token: this.decryptToken(conn),
        };
    }

    async upsert(ctx: RequestContext, input: UpdateBolesaConnectionInput): Promise<BolesaConnection> {
        let entity = await this.getForChannel(ctx);
        if (!entity) {
            entity = new BolesaConnection({
                apiBaseUrl: input.apiBaseUrl ?? this.options.apiBaseUrl,
                tokenEncrypted: '',
                tokenLast4: '',
                isActive: true,
            });
            await this.channelService.assignToCurrentChannel(entity, ctx);
        }

        if (input.apiBaseUrl !== undefined) {
            entity.apiBaseUrl = input.apiBaseUrl.replace(/\/$/, '');
        }
        if (input.token) {
            entity.tokenEncrypted = this.encrypt(input.token);
            entity.tokenLast4 = input.token.slice(-4);
        }
        if (input.shipperAddress !== undefined) {
            entity.shipperAddress = input.shipperAddress;
        }
        if (input.enabledServiceSlugs !== undefined) {
            entity.enabledServiceSlugs = merchantServiceSlugs(input.enabledServiceSlugs);
        }
        if (input.serviceOffers !== undefined) {
            const enabled = merchantServiceSlugs(entity.enabledServiceSlugs);
            entity.serviceOffers = normalizeServiceOffers(input.serviceOffers)
                .filter(offer => enabled.includes(offer.slug));
        }
        if (input.codMinimumMajor !== undefined) {
            const minimum = Number(input.codMinimumMajor);
            if (!Number.isFinite(minimum) || minimum < 0) {
                throw new UserInputError('Cash on delivery minimum must be zero or greater.');
            }
            entity.codMinimumMajor = minimum;
        }
        if (input.allowOpen !== undefined) {
            entity.allowOpen = input.allowOpen;
        }
        if (input.autoCreateAwb !== undefined) {
            entity.autoCreateAwb = input.autoCreateAwb;
        }
        if (input.defaultServiceSlug !== undefined) {
            entity.defaultServiceSlug = input.defaultServiceSlug?.trim() || null;
        }
        const checkCatalog =
            input.enabledServiceSlugs !== undefined ||
            input.defaultServiceSlug !== undefined ||
            input.autoCreateAwb === true;
        await this.assertMerchantServices(entity, checkCatalog);
        if (input.shipmentCategory !== undefined) {
            entity.shipmentCategory = input.shipmentCategory;
        }
        if (input.creationMode !== undefined) {
            entity.creationMode = input.creationMode;
        }
        if (input.codEnabled !== undefined) {
            entity.codEnabled = input.codEnabled;
        }
        if (input.codFeeMode !== undefined) {
            entity.codFeeMode = input.codFeeMode;
        }
        if (input.markupPercent !== undefined) {
            entity.markupPercent = input.markupPercent;
        }
        if (input.isActive !== undefined) {
            entity.isActive = input.isActive;
        }

        await this.keepStoredRates(ctx, entity);
        return this.connection.getRepository(ctx, BolesaConnection).save(entity);
    }

    /** Partner catalogue for the settings page. Not used as checkout prices. */
    async listAccountServices(
        ctx: RequestContext,
    ): Promise<Array<{ slug: string; name: string; logoUrl?: string }>> {
        const conn = await this.getForChannel(ctx);
        if (!conn?.tokenEncrypted) {
            return normalizeAccountServices(conn?.accountServices);
        }
        try {
            const live = await this.client.listAccountServices(this.authFor(conn));
            await this.storeAccountServices(conn, live);
            return live;
        } catch (e: any) {
            const message = e instanceof BolesaApiError ? `${e.code}: ${e.message}` : e?.message;
            Logger.warn(`Bolesa service list failed; using the saved list: ${message}`, loggerCtx);
            return normalizeAccountServices(conn.accountServices);
        }
    }

    /**
     * Remember finite prices from one services/options response.
     * A later checkout still calls the API. These rows are only the last return.
     */
    async rememberReturnedRates(ctx: RequestContext, services: BolesaServiceOption[]): Promise<void> {
        const conn = await this.getForChannel(ctx);
        if (!conn) {
            return;
        }
        const next = mergeServiceRates(conn.serviceRates, services, new Date().toISOString());
        if (sameServiceRates(conn.serviceRates, next)) {
            return;
        }
        conn.serviceRates = next;
        await this.writeJsonColumn(conn.id, 'serviceRates', next);
    }

    async testConnection(ctx: RequestContext): Promise<{ ok: boolean; message: string }> {
        const conn = await this.requireActive(ctx);
        try {
            await this.client.me(this.authFor(conn));
            conn.lastVerifiedAt = new Date();
            await this.keepStoredRates(ctx, conn);
            await this.connection.getRepository(ctx, BolesaConnection).save(conn);
            return { ok: true, message: 'Bolesa Partner API token accepted' };
        } catch (e: any) {
            const message = e instanceof BolesaApiError ? `${e.code}: ${e.message}` : e?.message;
            Logger.warn(`Bolesa connection test failed: ${message}`, loggerCtx);
            return { ok: false, message: String(message) };
        }
    }

    /** Safe Admin view — never includes plaintext token or webhook secret. */
    toPublicView(conn: BolesaConnection | null) {
        if (!conn) {
            return null;
        }
        return {
            id: conn.id,
            apiBaseUrl: conn.apiBaseUrl,
            tokenLast4: conn.tokenLast4,
            webhookApproved: conn.webhookApproved,
            shipperAddress: conn.shipperAddress,
            defaultServiceSlug: conn.defaultServiceSlug,
            enabledServiceSlugs: merchantServiceSlugs(conn.enabledServiceSlugs),
            serviceOffers: normalizeServiceOffers(conn.serviceOffers),
            accountServices: normalizeAccountServices(conn.accountServices),
            serviceRates: normalizeServiceRates(conn.serviceRates),
            codMinimumMajor: Number.isFinite(Number(conn.codMinimumMajor)) ? Number(conn.codMinimumMajor) : 1000,
            allowOpen: conn.allowOpen === true,
            autoCreateAwb: conn.autoCreateAwb === true,
            shipmentCategory: conn.shipmentCategory,
            creationMode: conn.creationMode,
            codEnabled: conn.codEnabled,
            codFeeMode: conn.codFeeMode,
            markupPercent: conn.markupPercent,
            isActive: conn.isActive,
            lastVerifiedAt: conn.lastVerifiedAt,
            labelNote:
                'Labels from Partner API label_url may be private (Phase 0: S3 403). Download requires a future Bolesa label endpoint.',
        };
    }

    /**
     * Automatic creation needs a default service. A default must be one of the
     * services the merchant enabled. Slugs are checked against GET /services when a token exists.
     */
    private async assertMerchantServices(entity: BolesaConnection, checkCatalog: boolean): Promise<void> {
        const enabled = merchantServiceSlugs(entity.enabledServiceSlugs);
        const fallback = entity.defaultServiceSlug?.trim() || '';
        if (entity.autoCreateAwb && !fallback) {
            throw new UserInputError(
                'Automatic AWB creation needs a default Bolesa service. Choose one from the enabled services.',
            );
        }
        if (fallback && enabled.length && !enabled.includes(fallback)) {
            throw new UserInputError(
                `Default service ${fallback} is not in the services enabled for this channel.`,
            );
        }
        if (!checkCatalog || !entity.tokenEncrypted || (!enabled.length && !fallback)) {
            return;
        }
        let catalog: string[] = [];
        try {
            const live = await this.client.listAccountServices(this.authFor(entity));
            this.assignAccountServices(entity, live);
            catalog = live.map(row => row.slug);
        } catch (e: any) {
            catalog = normalizeAccountServices(entity.accountServices).map(row => row.slug);
            if (!catalog.length) {
                const message = e instanceof BolesaApiError ? `${e.code}: ${e.message}` : e?.message;
                throw new UserInputError(
                    `Could not verify Bolesa services: ${message}. The service list was not saved.`,
                );
            }
            const message = e instanceof BolesaApiError ? `${e.code}: ${e.message}` : e?.message;
            Logger.warn(`Bolesa service list failed; checked the saved list: ${message}`, loggerCtx);
        }
        const unknown = [...enabled, fallback].filter(slug => slug && !catalog.includes(slug));
        if (unknown.length) {
            throw new UserInputError(
                `Unknown Bolesa service: ${[...new Set(unknown)].join(', ')}. Refresh the account service list.`,
            );
        }
    }

    private async storeAccountServices(
        entity: BolesaConnection,
        live: Array<{ slug: string; name: string }>,
    ): Promise<void> {
        if (!this.assignAccountServices(entity, live) || !entity.id) {
            return;
        }
        await this.writeJsonColumn(entity.id, 'accountServices', entity.accountServices);
    }

    /** A full entity save must not replace rates stored by a checkout that finished during this request. */
    private async keepStoredRates(ctx: RequestContext, entity: BolesaConnection): Promise<void> {
        if (!entity.id) {
            return;
        }
        const latest = await this.connection.getRepository(ctx, BolesaConnection).findOne({
            where: { id: entity.id },
        });
        if (latest) {
            entity.serviceRates = latest.serviceRates;
        }
    }

    private async writeJsonColumn(
        id: BolesaConnection['id'],
        column: 'accountServices' | 'serviceRates',
        value: unknown,
    ): Promise<void> {
        await this.connection.rawConnection.query(
            `UPDATE "bolesa_connection" SET "${column}" = $1 WHERE id = $2`,
            [JSON.stringify(value), id],
        );
    }

    private assignAccountServices(
        entity: BolesaConnection,
        live: Array<{ slug: string; name: string }>,
    ): boolean {
        const catalog = normalizeAccountServices(live);
        if (sameAccountServices(entity.accountServices, catalog)) {
            return false;
        }
        entity.accountServices = catalog;
        return true;
    }

    private encrypt(plaintext: string): string {
        const strategy = this.configService.systemOptions.encryptionStrategy;
        if (!strategy?.isConfigured()) {
            throw new Error(
                'Configure systemOptions.encryptionStrategy (e.g. DefaultEncryptionStrategy) before saving Bolesa tokens',
            );
        }
        return strategy.encrypt(plaintext);
    }
}
