import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    PARTNER_ADDRESS_LINE_MIN,
    partnerAddressLine,
} from '../util/partner-address-line';

describe('partnerAddressLine', () => {
    it('keeps lines that already meet the Partner minimum', () => {
        assert.equal(
            partnerAddressLine('12 Test Street Nasr City'),
            '12 Test Street Nasr City',
        );
    });

    it('joins street/city/province parts', () => {
        assert.equal(
            partnerAddressLine('1 St', undefined, 'Nasr City', 'Cairo'),
            '1 St, Nasr City, Cairo',
        );
    });

    it('pads short streets so Partner min length is satisfied', () => {
        const out = partnerAddressLine('1 St');
        assert.ok(out.length >= PARTNER_ADDRESS_LINE_MIN);
        assert.equal(out.slice(0, 4), '1 St');
    });

    it('uses a padded default when every part is empty', () => {
        const out = partnerAddressLine('', null, undefined);
        assert.ok(out.length >= PARTNER_ADDRESS_LINE_MIN);
        assert.match(out, /^Delivery address/);
    });
});
