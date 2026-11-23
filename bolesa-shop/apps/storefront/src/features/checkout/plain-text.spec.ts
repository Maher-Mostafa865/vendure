import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainText } from './plain-text';

describe('plainText', () => {
    it('removes the paragraph tags saved by the dashboard editor', () => {
        assert.equal(plainText('<p>standard-shipping-egypt desc</p>'), 'standard-shipping-egypt desc');
    });

    it('returns an empty string for blank markup', () => {
        assert.equal(plainText('<p> </p>'), '');
        assert.equal(plainText(null), '');
    });
});
