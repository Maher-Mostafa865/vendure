import { Channel, ChannelAware, DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinTable, ManyToMany } from 'typeorm';

import { PaymobMode, PaymobStoredCredentials } from '../types';

@Entity('paymob_connection')
export class PaymobConnection extends VendureEntity implements ChannelAware {
    constructor(input?: DeepPartial<PaymobConnection>) {
        super(input);
    }

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];

    /** Which credential set is used for new checkouts. */
    @Column({ type: 'varchar', length: 8, default: 'test' })
    mode: PaymobMode;

    @Column({ type: 'simple-json', nullable: true })
    testCredentials: PaymobStoredCredentials | null;

    @Column({ type: 'simple-json', nullable: true })
    liveCredentials: PaymobStoredCredentials | null;

    @Index()
    @Column({ type: 'boolean', default: true })
    isActive: boolean;
}
