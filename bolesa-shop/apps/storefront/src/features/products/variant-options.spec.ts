import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatVariantOptions } from './variant-options';

describe('formatVariantOptions', () => {
    it('lists every selected option, including ones missing from the variant name', () => {
        const label = formatVariantOptions([
            { name: 'm', group: { name: 'sizes' } },
            { name: '8', group: { name: 'RAM' } },
        ]);

        assert.equal(label, 'sizes: m · RAM: 8');
    });

    it('trims option names and skips blank values', () => {
        const label = formatVariantOptions([
            { name: '16 ', group: { name: ' RAM ' } },
            { name: ' ', group: { name: 'sizes' } },
        ]);

        assert.equal(label, 'RAM: 16');
    });
});
