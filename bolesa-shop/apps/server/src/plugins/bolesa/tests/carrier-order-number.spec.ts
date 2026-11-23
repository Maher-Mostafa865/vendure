import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    CARRIER_ORDER_NUMBER_LENGTH,
    TEST_CARRIER_ORDER_NUMBER,
    carrierOrderNumber,
} from '../util/carrier-order-number';

describe('carrier order number', () => {
    it('sends F8CE35 for order F8CE35EUZTDCWBRB', () => {
        assert.equal(
            carrierOrderNumber('F8CE35EUZTDCWBRB', 'bolesa-f2-c2-a9'),
            TEST_CARRIER_ORDER_NUMBER,
        );
        assert.equal(TEST_CARRIER_ORDER_NUMBER, 'F8CE35');
    });

    it('sends 16 hexadecimal characters for any other order', () => {
        const number = carrierOrderNumber('PH7RE7WEDFUHKYP8', 'bolesa-f1-c2-a1');
        assert.equal(number.length, CARRIER_ORDER_NUMBER_LENGTH);
        assert.match(number, /^[0-9A-F]{16}$/);
        assert.notEqual(
            carrierOrderNumber('PH7RE7WEDFUHKYP8', 'bolesa-f1-c2-a2'),
            number,
        );
    });
});
