import { Channel, ChannelAware, DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinTable, ManyToMany } from 'typeorm';

@Entity('bolesa_connection')
export class BolesaConnection extends VendureEntity implements ChannelAware {
    constructor(input?: DeepPartial<BolesaConnection>) {
        super(input);
    }

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];

    @Column({ type: 'varchar', length: 64, nullable: true })
    bolesaAccountId: string | null;

    @Column({ type: 'varchar', length: 512 })
    apiBaseUrl: string;

    /** Encrypted XP-Api-Token ciphertext (enc:v1:...). Never expose via Shop API. */
    @Column({ type: 'text' })
    tokenEncrypted: string;

    @Column({ type: 'varchar', length: 8, default: '' })
    tokenLast4: string;

    @Column({ type: 'varchar', length: 64, nullable: true })
    webhookSubscriptionUuid: string | null;

    @Column({ type: 'text', nullable: true })
    webhookSecretEncrypted: string | null;

    @Column({ default: false })
    webhookApproved: boolean;

    /** JSON shipper address including resolution_hash */
    @Column({ type: 'simple-json', nullable: true })
    shipperAddress: Record<string, unknown> | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    defaultServiceSlug: string | null;

    @Column({ type: 'varchar', length: 16, default: 'dry' })
    shipmentCategory: 'dry' | 'heavy' | 'cold';

    /** manual | onPaymentSettled | onPlaced */
    @Column({ type: 'varchar', length: 32, default: 'manual' })
    creationMode: 'manual' | 'onPaymentSettled' | 'onPlaced';

    @Column({ default: true })
    codEnabled: boolean;

    /** absorb | passToCustomer */
    @Column({ type: 'varchar', length: 32, default: 'absorb' })
    codFeeMode: 'absorb' | 'passToCustomer';

    @Column({ type: 'float', default: 0 })
    markupPercent: number;

    @Index()
    @Column({ default: true })
    isActive: boolean;

    @Column({ type: 'timestamp', nullable: true })
    lastVerifiedAt: Date | null;
}
