import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatMajor, majorToMinor, minorToMajor } from '../util/money';

describe('money conversion', () => {
    it('converts minor units to EGP major', () => {
        assert.equal(minorToMajor(12345), 123.45);
        assert.equal(minorToMajor(1), 0.01);
        assert.equal(minorToMajor(0), 0);
    });

    it('converts EGP major to minor units with rounding', () => {
        assert.equal(majorToMinor(123.45), 12345);
        assert.equal(majorToMinor(10.005), 1001); // banker's? Math.round → 1001
        assert.equal(majorToMinor(10.004), 1000);
    });

    it('formats major to 2 decimals', () => {
        assert.equal(formatMajor(10.456), 10.46);
        assert.equal(formatMajor(10.454), 10.45);
    });
});
