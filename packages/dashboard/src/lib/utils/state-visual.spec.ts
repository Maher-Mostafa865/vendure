import { describe, expect, it } from 'vitest';

import { getStateVisual } from './state-visual.js';

describe('getStateVisual', () => {
    it('gives the payment-settled transition targets distinct icons', () => {
        const states = [
            'PaymentSettled',
            'PartiallyDelivered',
            'Delivered',
            'PartiallyShipped',
            'Shipped',
            'Cancelled',
            'ArrangingAdditionalPayment',
        ];
        const icons = states.map(state => getStateVisual(state).icon);

        expect(new Set(icons).size).toBe(states.length);
    });

    it('gives payment states distinct icons', () => {
        const states = ['Created', 'Authorized', 'Settled', 'Declined', 'Error', 'Cancelled'];
        const icons = states.map(state => getStateVisual(state).icon);

        expect(new Set(icons).size).toBe(states.length);
    });

    it('gives fulfillment states distinct icons', () => {
        const states = ['Created', 'Pending', 'Shipped', 'Delivered', 'Cancelled'];
        const icons = states.map(state => getStateVisual(state).icon);

        expect(new Set(icons).size).toBe(states.length);
    });

    it('uses a destructive mark for cancellation and a success mark for settled payment', () => {
        expect(getStateVisual('Cancelled').className).toContain('text-destructive');
        expect(getStateVisual('PaymentSettled').className).toContain('text-success');
        expect(getStateVisual('Pending').className).toContain('text-warning');
    });

    it('falls back for a custom process state', () => {
        expect(getStateVisual('CustomWarehouseHold').icon).toBeTruthy();
    });
});
