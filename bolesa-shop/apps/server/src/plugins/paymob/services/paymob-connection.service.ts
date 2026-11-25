import { Injectable } from '@nestjs/common';
import {
    ChannelService,
    ConfigService,
    RequestContext,
    TransactionalConnection,
    UserInputError,
    isGraphQlErrorResult,
} from '@vendure/core';

import { PaymobConnection } from '../entities/paymob-connection.entity';
import {
    MarketCountry,
    PaymobActiveCredentials,
    PaymobCredentialInput,
    PaymobMode,
} from '../types';
import {
    assertCredentialsComplete,
    credentialPublicView,
    decryptCredentials,
    mergeCredentialInput,
    pickStoredCredentials,
} from '../util/credentials';

export interface UpdatePaymobConnectionInput {
    mode?: PaymobMode;
    isActive?: boolean;
    marketCountry?: MarketCountry;
    testCredentials?: PaymobCredentialInput | null;
    liveCredentials?: PaymobCredentialInput | null;
}

@Injectable()
export class PaymobConnectionService {
    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private configService: ConfigService,
    ) {}

    async getForChannel(ctx: RequestContext): Promise<PaymobConnection | null> {
        return this.connection.rawConnection
            .getRepository(PaymobConnection)
            .createQueryBuilder('c')
            .innerJoin('c.channels', 'ch', 'ch.id = :channelId', { channelId: ctx.channelId })
            .orderBy('c.id', 'ASC')
            .getOne();
    }

    async requireActive(ctx: RequestContext): Promise<PaymobConnection> {
        const conn = await this.getForChannel(ctx);
        if (!conn || !conn.isActive) {
            throw new UserInputError('Paymob connection is not configured or inactive for this channel');
        }
        return conn;
    }

    activeCredentials(conn: PaymobConnection): PaymobActiveCredentials {
        const stored = pickStoredCredentials(conn);
        if (!stored) {
            throw new UserInputError(`Paymob ${conn.mode} credentials are not configured`);
        }
        const creds = decryptCredentials(stored, ciphertext => this.decrypt(ciphertext));
        assertCredentialsComplete(creds);
        return creds;
    }

    async upsert(ctx: RequestContext, input: UpdatePaymobConnectionInput): Promise<PaymobConnection> {
        let entity = await this.getForChannel(ctx);
        if (!entity) {
            entity = new PaymobConnection({
                mode: 'test',
                testCredentials: null,
                liveCredentials: null,
                isActive: true,
            });
            await this.channelService.assignToCurrentChannel(entity, ctx);
        }

        if (input.mode !== undefined) {
            if (input.mode !== 'test' && input.mode !== 'live') {
                throw new UserInputError('mode must be test or live');
            }
            entity.mode = input.mode;
        }
        if (input.isActive !== undefined) {
            entity.isActive = input.isActive;
        }
        if (input.testCredentials !== undefined) {
            entity.testCredentials = mergeCredentialInput(
                entity.testCredentials,
                input.testCredentials,
                plaintext => this.encrypt(plaintext),
            );
        }
        if (input.liveCredentials !== undefined) {
            entity.liveCredentials = mergeCredentialInput(
                entity.liveCredentials,
                input.liveCredentials,
                plaintext => this.encrypt(plaintext),
            );
        }

        const saved = await this.connection.getRepository(ctx, PaymobConnection).save(entity);

        if (input.marketCountry !== undefined) {
            await this.updateChannelMarketCountry(ctx, input.marketCountry);
        }

        return saved;
    }

    async updateChannelMarketCountry(ctx: RequestContext, marketCountry: MarketCountry): Promise<void> {
        if (marketCountry !== 'EG' && marketCountry !== 'SA') {
            throw new UserInputError('marketCountry must be EG or SA');
        }
        const result = await this.channelService.update(ctx, {
            id: ctx.channelId,
            customFields: { marketCountry },
        });
        if (isGraphQlErrorResult(result)) {
            throw new UserInputError(result.message ?? 'Failed to update channel market country');
        }
    }

    toPublicView(conn: PaymobConnection | null, marketCountry: string) {
        if (!conn) {
            return {
                id: null,
                mode: 'test' as PaymobMode,
                // Default on for a new form so the first Save does not leave Paymob ineligible at checkout.
                isActive: true,
                marketCountry: marketCountry || 'EG',
                testCredentials: credentialPublicView(null),
                liveCredentials: credentialPublicView(null),
            };
        }
        return {
            id: conn.id,
            mode: conn.mode,
            isActive: conn.isActive,
            marketCountry: marketCountry || 'EG',
            testCredentials: credentialPublicView(conn.testCredentials),
            liveCredentials: credentialPublicView(conn.liveCredentials),
        };
    }

    private encrypt(plaintext: string): string {
        const strategy = this.configService.systemOptions.encryptionStrategy;
        if (!strategy?.isConfigured()) {
            throw new Error(
                'Configure systemOptions.encryptionStrategy before saving Paymob credentials',
            );
        }
        return strategy.encrypt(plaintext);
    }

    private decrypt(ciphertext: string): string {
        const strategy = this.configService.systemOptions.encryptionStrategy;
        if (!strategy?.isConfigured()) {
            throw new Error('EncryptionStrategy is not configured; cannot decrypt Paymob credentials');
        }
        return strategy.decrypt(ciphertext);
    }
}
