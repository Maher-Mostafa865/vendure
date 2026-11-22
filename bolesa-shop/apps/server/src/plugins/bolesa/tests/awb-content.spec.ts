import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BolesaApiError } from '../services/bolesa-client.service';
import { buildAwbShipmentContent } from '../util/awb-content';

describe('create AWB shipment content', () => {
    it('collapses every order line into one piece', () => {
        const content = buildAwbShipmentContent(
            [
                { name: 'Laptop 13 inch 8GB', quantity: 1, weightKg: 1 },
                { name: 'Aloe Vera', quantity: 1, weightKg: 1 },
            ],
            '7389KG9D28FLZ2WC',
        );
        assert.equal(content.numberOfPieces, 1);
        assert.equal(content.parcels.length, 1);
        assert.equal(content.parcels[0].actual_weight, 2);
        assert.equal(content.weightKg, 2);
        assert.match(content.description, /Laptop 13 inch 8GB x1/);
        assert.match(content.description, /Aloe Vera x1/);
    });

    it('includes Partner field errors in the stored failure', () => {
        const error = new BolesaApiError(
            'carrier_rejected',
            'The carrier rejected the shipment.',
            422,
            {
                success: false,
                errors: { number_of_pieces: ['The number of pieces may not be greater than 1.'] },
            },
        );
        assert.match(error.detail(), /number_of_pieces/);
        assert.match(error.detail(), /may not be greater than 1/);
    });
});