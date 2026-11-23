import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeServiceRates, sameServiceRates } from '../util/service-rates';

describe('mergeServiceRates', () => {
    it('stores each returned card and cash price and keeps the other side', () => {
        const card = mergeServiceRates([], [
            { slug: 'smsa', ccPrice: 95.54, codPrice: null, currencyCode: 'EGP' },
        ], '2026-11-23T14:00:00.000Z');
        assert.equal(card[0].ccPriceMinor, 9554);
        assert.equal(card[0].codPriceMinor, null);

        const both = mergeServiceRates(card, [
            { slug: 'smsa', ccPrice: null, codPrice: 110.5, currencyCode: 'EGP' },
        ], '2026-11-23T15:00:00.000Z');
        assert.equal(both[0].ccPriceMinor, 9554);
        assert.equal(both[0].codPriceMinor, 11050);
        assert.equal(both[0].quotedAt, '2026-11-23T15:00:00.000Z');
    });

    it('does not write again when the returned prices are unchanged', () => {
        const stored = mergeServiceRates([], [
            { slug: 'bosta', ccPrice: 40, codPrice: 45, currencyCode: 'EGP' },
        ], '2026-11-23T14:00:00.000Z');
        const again = mergeServiceRates(stored, [
            { slug: 'bosta', ccPrice: 40, codPrice: 45, currencyCode: 'EGP' },
        ], '2026-11-23T16:00:00.000Z');
        assert.equal(sameServiceRates(stored, again), true);
    });

    it('drops the old prices when the carrier currency changes', () => {
        const stored = mergeServiceRates([], [
            { slug: 'bosta', ccPrice: 40, codPrice: 45, currencyCode: 'EGP' },
        ], '2026-11-23T14:00:00.000Z');
        const replaced = mergeServiceRates(stored, [
            { slug: 'bosta', ccPrice: 3, currencyCode: 'SAR' },
        ], '2026-11-23T16:00:00.000Z');
        assert.equal(replaced[0].currencyCode, 'SAR');
        assert.equal(replaced[0].ccPriceMinor, 300);
        assert.equal(replaced[0].codPriceMinor, null);
    });
});
