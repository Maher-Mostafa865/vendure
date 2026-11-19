import { Channel, ChannelAware, DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinTable, ManyToMany } from 'typeorm';

import {
    BolesaShipmentSyncStatus,
    CodCollectionStatus,
    CodRemittanceStatus,
} from '../types';

@Entity('bolesa_shipment')
export class BolesaShipment extends VendureEntity implements ChannelAware {
    constructor(input?: DeepPartial<BolesaShipment>) {
        super(input);
    }

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];

    @Index({ unique: true })
    @EntityId()
    fulfillmentId: ID;

    @EntityId()
    orderId: ID;

    @EntityId()
    channelId: ID;

    @Index()
    @Column({ type: 'varchar', length: 64, nullable: true })
    trackingNumber: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    awbReference: string | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    carrierServiceSlug: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    statusCode: string | null;

    /**
     * Label URL from Partner API — may be private S3 (Phase 0: anonymous 403).
     * Never expose on Shop API. Do not claim download works until Bolesa label endpoint exists.
     */
    @Column({ type: 'text', nullable: true })
    labelUrl: string | null;

    @Column({ type: 'varchar', length: 32, default: 'unavailable' })
    labelAvailability: 'unavailable' | 'url_present' | 'ready';

    @Column({ type: 'float', nullable: true })
    codAmount: number | null;

    @Column({ type: 'simple-json', nullable: true })
    issuingFees: unknown;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 160 })
    shipmentKey: string;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 180 })
    idempotencyKey: string;

    @Column({ type: 'int', default: 1 })
    attempt: number;

    @Column({ type: 'varchar', length: 32, default: 'requested' })
    syncStatus: BolesaShipmentSyncStatus;

    @Column({ type: 'varchar', length: 32, default: 'pending' })
    codCollectionStatus: CodCollectionStatus;

    @Column({ type: 'varchar', length: 32, default: 'unknown' })
    codRemittanceStatus: CodRemittanceStatus;

    @Column({ type: 'timestamp', nullable: true })
    lastStatusAt: Date | null;

    @Column({ type: 'timestamp', nullable: true })
    lastErrorAt: Date | null;

    @Column({ type: 'text', nullable: true })
    lastError: string | null;

    @Column({ type: 'simple-json', nullable: true })
    rawLastPayload: unknown;
}
